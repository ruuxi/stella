import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "../../../../../runtime/kernel/agent-core/types.js";
import type {
  OrchestratorRunOptions,
  SubagentRunOptions,
} from "../../../../../runtime/kernel/agent-runtime/types.js";
import { BackgroundCompactionScheduler } from "../../../../../runtime/kernel/agent-runtime/compaction-scheduler.js";
import { OrchestratorSession } from "../../../../../runtime/kernel/agent-runtime/orchestrator-session.js";
import { SubagentSession } from "../../../../../runtime/kernel/agent-runtime/subagent-session.js";
import { createExternalOrchestratorRunSession } from "../../../../../runtime/kernel/agent-runtime/run-session.js";
import { loadStellaRuntimeAgents } from "../../../../../runtime/extensions/stella-runtime/index.js";
import { providerAbortedStopMessage } from "../../../../../runtime/ai/utils/provider-stop.js";

const executeRuntimeAgentPrompt = vi.fn();

vi.mock("../../../../../runtime/kernel/agent-runtime/run-execution.js", () => ({
  executeRuntimeAgentPrompt: (...args: unknown[]) =>
    executeRuntimeAgentPrompt(...args),
}));

const model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as const;

const safetyModel = {
  ...model,
  id: "anthropic/claude-fable-5",
  name: "Claude Fable 5",
} as const;

const assistantMessage = (args: {
  text?: string;
  errorMessage?: string;
  timestamp: number;
}) => ({
  role: "assistant" as const,
  content: args.text ? [{ type: "text" as const, text: args.text }] : [],
  api: "openai-completions" as const,
  provider: "test",
  model: safetyModel.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: args.errorMessage ? ("error" as const) : ("stop" as const),
  ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
  timestamp: args.timestamp,
});

const textFromMessages = (messages: AgentMessage[]): string[] =>
  messages.map((message) => {
    if (typeof message.content === "string") {
      return message.content;
    }
    return message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
  });

const createOptions = (
  overrides: Partial<OrchestratorRunOptions> = {},
): OrchestratorRunOptions => ({
  runId: "run-1",
  conversationId: "conversation-1",
  userMessageId: "user-message-1",
  agentType: "orchestrator",
  userPrompt: "Hello",
  agentContext: {
    systemPrompt: "System prompt",
    dynamicContext: "",
    maxAgentDepth: 1,
    reasoningEffort: "high",
    threadHistory: [
      {
        role: "user",
        content: "Initial persisted history",
        timestamp: 1,
      },
    ],
  },
  toolCatalog: [],
  toolExecutor: vi.fn(async () => ({ result: "ok" })),
  deviceId: "device-1",
  stellaDataDir: "/tmp/stella",
  stellaAppDir: "/tmp/stella",
  resolvedLlm: {
    model,
    route: "direct-provider",
    getApiKey: () => undefined,
  },
  store: {
    recordRunEvent: vi.fn(),
    updateOrchestratorReminderCounter: vi.fn(),
  } as never,
  callbacks: {
    onStream: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
  },
  compactionScheduler: new BackgroundCompactionScheduler(),
  ...overrides,
});

describe("OrchestratorSession", () => {
  beforeEach(() => {
    executeRuntimeAgentPrompt.mockReset();
  });

  it("reuses the live Pi Agent across turns", async () => {
    const session = new OrchestratorSession("conversation-1");
    const seenAgents: unknown[] = [];

    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      seenAgents.push(agent);
      return { finalText: "done" };
    });

    await session.runTurn(createOptions({ runId: "run-1" }));
    await session.runTurn(
      createOptions({ runId: "run-2", userPrompt: "Again" }),
    );

    expect(seenAgents).toHaveLength(2);
    expect(seenAgents[1]).toBe(seenAgents[0]);
  });

  it("retries a transient failure from the resumed same-model safety stage", async () => {
    const session = new OrchestratorSession("conversation-safety-retry");
    const safetyError = providerAbortedStopMessage("refusal");
    const executions = [
      { finalText: "", errorMessage: safetyError },
      { finalText: "", errorMessage: "500 Server Error" },
      { finalText: "recovered" },
    ];

    executeRuntimeAgentPrompt.mockImplementation(
      async ({
        agent,
        resume,
      }: {
        agent: { state: { messages: AgentMessage[] } };
        resume?: boolean;
      }) => {
        const call = executeRuntimeAgentPrompt.mock.calls.length;
        const execution = executions[call - 1]!;
        agent.state.messages.push(
          assistantMessage({
            ...(execution.finalText ? { text: execution.finalText } : {}),
            ...(execution.errorMessage
              ? { errorMessage: execution.errorMessage }
              : {}),
            timestamp: call,
          }),
        );
        if (call > 1) expect(resume).toBe(true);
        return execution;
      },
    );

    await session.runTurn(
      createOptions({
        runId: "run-safety-stage-transient",
        conversationId: "conversation-safety-retry",
        resolvedLlm: {
          model: safetyModel,
          route: "direct-provider",
          getApiKey: () => undefined,
        },
      }),
    );

    expect(executeRuntimeAgentPrompt).toHaveBeenCalledTimes(3);
    expect(
      executeRuntimeAgentPrompt.mock.calls.map(([args]) =>
        Boolean((args as { resume?: boolean }).resume),
      ),
    ).toEqual([false, true, true]);
  });

  it("refreshes the advertised tool schema on the next turn of an open session", async () => {
    const session = new OrchestratorSession("conversation-1");
    const advertisedTools: string[][] = [];
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "stella-tool-refresh-"),
    );
    const homeAgentsDir = path.join(tempRoot, "agents");
    const oldMetadataDir = path.join(tempRoot, "old-agent-metadata");
    await mkdir(homeAgentsDir, { recursive: true });
    await mkdir(oldMetadataDir, { recursive: true });
    const oldTools = ["spawn_agent", "send_input", "pause_agent"];
    await writeFile(
      path.join(homeAgentsDir, "orchestrator.md"),
      [
        "---",
        "name: Customized Orchestrator",
        "description: User-customized prompt",
        `tools: ${oldTools.join(", ")}`,
        "maxAgentDepth: 1",
        "---",
        "Keep this customized prompt body.",
      ].join("\n"),
    );
    await writeFile(
      path.join(oldMetadataDir, "orchestrator.md"),
      [
        "---",
        "name: Orchestrator",
        "description: Old runtime capabilities",
        `tools: ${oldTools.join(", ")}`,
        "maxAgentDepth: 1",
        "---",
        "Legacy-compatible metadata body.",
      ].join("\n"),
    );
    const metadataDir = path.resolve(
      import.meta.dirname,
      "../../../../../runtime/extensions/stella-runtime/agent-metadata",
    );
    const beforeReload = loadStellaRuntimeAgents(tempRoot, oldMetadataDir).find(
      (agent) => agent.id === "orchestrator",
    );
    const afterReload = loadStellaRuntimeAgents(tempRoot, metadataDir).find(
      (agent) => agent.id === "orchestrator",
    );
    expect(beforeReload?.systemPrompt).toBe(
      "Keep this customized prompt body.",
    );
    expect(afterReload?.systemPrompt).toBe("Keep this customized prompt body.");
    expect(beforeReload?.toolsAllowlist).not.toContain("spawn_manager");
    expect(afterReload?.toolsAllowlist).toContain("spawn_manager");

    const toolMetadata = (name: string) => ({
      name,
      description: `${name} test tool`,
      parameters: { type: "object", properties: {} },
    });
    const originalTools = beforeReload?.toolsAllowlist ?? [];
    const updatedTools = afterReload?.toolsAllowlist ?? [];

    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      advertisedTools.push(agent.state.tools.map((tool) => tool.name));
      return { finalText: "done" };
    });

    await session.runTurn(
      createOptions({
        runId: "run-before-extension-reload",
        agentContext: {
          systemPrompt: "Customized prompt body",
          dynamicContext: "",
          maxAgentDepth: 1,
          toolsAllowlist: originalTools,
        },
        toolCatalog: originalTools.map(toolMetadata),
      }),
    );
    await session.runTurn(
      createOptions({
        runId: "run-after-extension-reload",
        userPrompt: "Continue in this conversation",
        agentContext: {
          systemPrompt: "Customized prompt body",
          dynamicContext: "",
          maxAgentDepth: 1,
          toolsAllowlist: updatedTools,
        },
        toolCatalog: updatedTools.map(toolMetadata),
      }),
    );

    expect(advertisedTools[0]).toEqual(originalTools);
    expect(advertisedTools[1]).toEqual(updatedTools);
    expect(advertisedTools[1]).toContain("spawn_manager");
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("refreshes the in-memory message mirror after compaction", async () => {
    const session = new OrchestratorSession("conversation-1");
    const startMessages: string[][] = [];

    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      startMessages.push(textFromMessages(agent.state.messages));
      return { finalText: "done" };
    });

    await session.runTurn(createOptions({ runId: "run-1" }));

    session.notifyCompacted();

    await session.runTurn(
      createOptions({
        runId: "run-2",
        userPrompt: "After compaction",
        agentContext: {
          systemPrompt: "System prompt",
          dynamicContext: "",
          maxAgentDepth: 1,
          reasoningEffort: "high",
          threadHistory: [
            {
              role: "assistant",
              content: "Compacted checkpoint summary",
              timestamp: 2,
            },
          ],
        },
      }),
    );

    expect(startMessages[0]).toContain("Initial persisted history");
    expect(startMessages[1]).toContain("Compacted checkpoint summary");
    expect(startMessages[1]).not.toContain("Initial persisted history");
  });
});

describe("SubagentSession", () => {
  beforeEach(() => {
    executeRuntimeAgentPrompt.mockReset();
  });

  it("reloads a history event persisted while the first Agent is being created", async () => {
    const session = new SubagentSession(
      "manager-thread",
      "conversation-1",
      "manager",
    );
    let releaseAgentStart!: () => void;
    const agentStartGate = new Promise<void>((resolve) => {
      releaseAgentStart = resolve;
    });
    let agentStartEntered!: () => void;
    const agentStartEnteredGate = new Promise<void>((resolve) => {
      agentStartEntered = resolve;
    });
    const persistedHistory = [
      {
        role: "user",
        content: "Stale snapshot before managed-child completion",
        timestamp: 1,
      },
    ];
    const store = {
      recordRunEvent: vi.fn(),
      appendThreadCustomMessage: vi.fn(),
      loadThreadMessages: vi.fn(() => persistedHistory),
    };
    const hookEmitter = {
      emitAll: vi.fn(async (event: string) => {
        if (event === "before_agent_start") {
          agentStartEntered();
          await agentStartGate;
        }
        return [];
      }),
      emit: vi.fn(async () => undefined),
    };
    let executionHistory: string[] = [];
    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      executionHistory = textFromMessages(agent.state.messages);
      return { finalText: "done" };
    });

    const turn = session.runTurn({
      runId: "manager-run-1",
      conversationId: "conversation-1",
      userMessageId: "manager-user-1",
      agentId: "manager-thread",
      agentType: "manager",
      userPrompt: "Review the new child event.",
      agentContext: {
        systemPrompt: "Manager prompt",
        dynamicContext: "",
        maxAgentDepth: 2,
        threadHistory: [...persistedHistory],
      },
      toolCatalog: [],
      toolExecutor: vi.fn(async () => ({ result: "ok" })),
      deviceId: "device-1",
      stellaDataDir: "/tmp/stella",
      stellaAppDir: "/tmp/stella",
      resolvedLlm: {
        model,
        route: "direct-provider",
        getApiKey: () => undefined,
      },
      store: store as never,
      hookEmitter: hookEmitter as never,
      callbacks: {},
      compactionScheduler: new BackgroundCompactionScheduler(),
    } satisfies SubagentRunOptions);

    await agentStartEnteredGate;
    persistedHistory.push({
      role: "runtimeInternal",
      content: "Child completed during manager session creation",
      timestamp: 2,
    });
    session.notifyHistoryChanged();
    releaseAgentStart();
    await turn;

    expect(store.loadThreadMessages).toHaveBeenCalledWith("manager-thread");
    expect(executionHistory).toContain(
      "Child completed during manager session creation",
    );
  });
});

describe("external engine session lifecycle", () => {
  it("runs the shared beforeRunEnd finalizer for Claude Code", async () => {
    const beforeRunEnd = vi.fn(async () => undefined);
    const options = createOptions({
      agentContext: {
        systemPrompt: "System prompt",
        dynamicContext: "",
        maxAgentDepth: 1,
        reasoningEffort: "high",
        agentEngine: "claude_code_local",
      },
      beforeRunEnd,
    });
    const session = createExternalOrchestratorRunSession(options, {
      runId: "claude-code-install-update",
    });

    await session.finalizeSuccess("Update applied");

    expect(beforeRunEnd).toHaveBeenCalledOnce();
    expect(beforeRunEnd).toHaveBeenCalledWith({
      runId: "claude-code-install-update",
      threadKey: "conversation-1",
      finalText: "Update applied",
      outcome: "success",
    });
  });
});
