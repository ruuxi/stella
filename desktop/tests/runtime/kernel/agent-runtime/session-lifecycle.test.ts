import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../../../runtime/kernel/agent-core/types.js";
import type { OrchestratorRunOptions } from "../../../../../runtime/kernel/agent-runtime/types.js";
import { BackgroundCompactionScheduler } from "../../../../../runtime/kernel/agent-runtime/compaction-scheduler.js";
import { OrchestratorSession } from "../../../../../runtime/kernel/agent-runtime/orchestrator-session.js";

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
  stellaHome: "/tmp/stella",
  stellaRoot: "/tmp/stella",
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
      return { finalText: "" };
    });

    await session.runTurn(createOptions({ runId: "run-1" }));
    await session.runTurn(createOptions({ runId: "run-2", userPrompt: "Again" }));

    expect(seenAgents).toHaveLength(2);
    expect(seenAgents[1]).toBe(seenAgents[0]);
  });

  it("refreshes the in-memory message mirror after compaction", async () => {
    const session = new OrchestratorSession("conversation-1");
    const startMessages: string[][] = [];

    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      startMessages.push(textFromMessages(agent.state.messages));
      return { finalText: "" };
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
