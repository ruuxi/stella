import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalChatHistoryService } from "../../../../electron/services/local-chat-history-service.js";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import {
  AGENT_PAUSE_CANCEL_REASON,
  type AgentLifecycleEvent,
  type LocalAgentManager,
} from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import { createAgentOrchestration } from "../../../../../runtime/kernel/runner/agent-orchestration.js";
import {
  handleSendInput,
  handleSpawnAgent,
} from "../../../../../runtime/kernel/tools/state.js";
import type { AgentModelConfigSnapshot } from "../../../../../runtime/contracts/agent-engine.js";
import type { RunnerContext } from "../../../../../runtime/kernel/runner/types.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
import type {
  LocalChatAppendEventArgs,
  SqliteDatabase,
} from "../../../../../runtime/kernel/storage/shared.js";
import { Agent } from "../../../../../runtime/kernel/agent-core/agent.js";
import { PiSessionCore } from "../../../../../runtime/kernel/agent-runtime/pi-session-core.js";
import { executeRuntimeAgentPrompt } from "../../../../../runtime/kernel/agent-runtime/run-execution.js";
import { createRuntimeAgent } from "../../../../../runtime/kernel/agent-runtime/shared.js";
import {
  executeAgentTurnWithRetry,
  type AgentRunFailure,
} from "../../../../../runtime/kernel/agent-runtime/agent-run-retry.js";
import { createAssistantMessageEventStream } from "../../../../../runtime/ai/utils/event-stream.js";
import type {
  Api,
  AssistantMessage,
  Model,
} from "../../../../../runtime/ai/types.js";

/**
 * Production routing for subagents of ANY parent agent.
 *
 * There is no "manager" agent type anymore: a plain General agent that spawns
 * work becomes the owning parent of that work. Everything these tests pin
 * follows from one rule in `handleAgentLifecycleEvent` — when a lifecycle
 * event resolves to a parent thread, it is delivered to that parent alone
 * (durable report + wake) and never to root chat, the run callbacks, or the
 * OS notification they drive.
 */

type MockRunArgs = {
  agentId?: string;
  agentType: string;
  userPrompt: string;
  abortSignal?: AbortSignal;
  agentContext?: {
    threadHistory?: Array<{ content: string }>;
    toolsAllowlist?: string[];
  };
  toolExecutor?: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<unknown>;
  callbacks?: {
    onStatus?: (event: {
      statusText: string;
      statusState: "provider-retry";
    }) => void;
  };
};

const runMock = vi.hoisted(() => ({
  handler: null as
    | null
    | ((args: MockRunArgs) => Promise<{
        runId: string;
        result: string;
        interrupted?: boolean;
        error?: string;
      }>),
}));

/**
 * The literal turn input a child report delivers. The report itself is already
 * durable in the parent's thread, so the wake carries only a pointer.
 */
const CHILD_REPORT_WAKE_INPUT =
  "A subagent you started has finished. Review its newly persisted report in this thread and continue your task.";

const PARENT_TERMINAL_REMINDER =
  "A subagent you started reached a terminal state.";

class RetryTestSession extends PiSessionCore {
  constructor() {
    super({
      threadKey: "subagent-retry-test",
      loggerName: "subagent-retry-test",
    });
  }

  prepareRetry(agent: Agent, failure: AgentRunFailure): boolean {
    return this.prepareAgentRunRetry(agent, {
      failure,
      logContext: {},
    });
  }
}

const emptyResponseModel = {
  id: "empty-response-model",
  name: "empty-response-model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://relay.example/api/llm",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 0,
} as Model<Api>;

const emptyAssistantMessage = (): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "openai",
  model: emptyResponseModel.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

const silentLengthTruncationMessage = (): AssistantMessage => ({
  ...emptyAssistantMessage(),
  content: [{ type: "thinking", thinking: "reasoning that hit the cap" }],
  usage: {
    ...emptyAssistantMessage().usage,
    output: 4096,
    totalTokens: 4096,
  },
  stopReason: "length",
});

vi.mock("../../../../../runtime/kernel/agent-runtime.js", () => ({
  runSubagentTask: (args: MockRunArgs) => {
    if (!runMock.handler) throw new Error("Missing subagent test run handler");
    return runMock.handler(args);
  },
  shutdownSubagentRuntimes: vi.fn(),
}));

type SentMessage = {
  text: string;
  customType?: string;
  responseTarget?: {
    type: string;
    agentId?: string;
    terminalState?: string;
  };
};

type Harness = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
  manager: LocalAgentManager;
  appendedEvents: LocalChatAppendEventArgs[];
  sentMessages: SentMessage[];
  streamedAgentEvents: AgentLifecycleEvent[];
  fetchedModelConfigs: Array<AgentModelConfigSnapshot | undefined>;
};

const harnesses = new Set<Harness>();

const waitUntil = async (predicate: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for subagent orchestration state");
};

const waitForAbort = async (signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) =>
    signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
};

const historyText = (args: MockRunArgs): string =>
  (args.agentContext?.threadHistory ?? [])
    .map((message) => message.content)
    .join("\n");

const threadHistoryText = (store: SessionStore, threadId: string): string =>
  store
    .loadThreadMessages(threadId)
    .map((message) => message.content)
    .join("\n");

/**
 * The structured, display-only lifecycle rows production writes into a PARENT
 * agent's own thread (`appendThreadLifecycleEvent`). This is what renders
 * subagent spawns/completions as cards in the parent's read-only thread view.
 */
const readThreadLifecycleRows = (rootPath: string, threadId: string) => {
  const historyService = new LocalChatHistoryService({
    stellaAppDir: rootPath,
  });
  try {
    return historyService
      .listAgentThreadMessages({ threadId, limit: 300 })
      .filter((message) => message.role === "lifecycle")
      .map((message) => message.lifecycleEvent!);
  } finally {
    historyService.close();
  }
};

const hasInFlightAttempt = (
  manager: LocalAgentManager,
  threadId: string,
): boolean =>
  (
    manager as unknown as {
      inFlightAttempts: Map<string, unknown>;
    }
  ).inFlightAttempts.has(threadId);

const productionEventHandlerOf = (
  manager: LocalAgentManager,
): ((event: AgentLifecycleEvent) => void) =>
  (
    manager as unknown as {
      opts: { onAgentEvent?: (event: AgentLifecycleEvent) => void };
    }
  ).opts.onAgentEvent!;

const createHarness = (options?: {
  rootPath?: string;
  attemptTeardownTimeoutMs?: number;
}): Harness => {
  const rootPath =
    options?.rootPath ??
    path.join(
      os.tmpdir(),
      `stella-subagent-orchestration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const store = new SessionStore(db);
  const appendedEvents: LocalChatAppendEventArgs[] = [];
  const sentMessages: SentMessage[] = [];
  const streamedAgentEvents: AgentLifecycleEvent[] = [];
  const fetchedModelConfigs: Array<AgentModelConfigSnapshot | undefined> = [];
  const context = {
    stellaAppDir: rootPath,
    stellaDataDir: rootPath,
    deviceId: "device-subagent-test",
    runtimeStore: store,
    appendLocalChatEvent: (event: LocalChatAppendEventArgs) => {
      appendedEvents.push(event);
      store.appendEvent(event);
    },
    notifyThreadActivityUpdated: vi.fn(),
    state: {
      localAgentManager: null,
      // The run-callback path is what fires the OS notification for a
      // lifecycle event. Recording it is how "no notification for a
      // subagent" becomes an assertable fact rather than a claim.
      runCallbacksByRunId: new Map([
        [
          "root-filter-run",
          {
            onAgentEvent: (event: AgentLifecycleEvent) => {
              streamedAgentEvents.push(event);
            },
          },
        ],
      ]),
      conversationCallbacks: new Map(),
      convexSiteUrl: null,
      authToken: null,
      hasConnectedAccount: false,
    },
    selfModHmrController: null,
    selfModLifecycle: null,
    selfModMonitor: null,
    toolHost: {
      getToolCatalog: () => [],
      executeTool: async () => ({ result: "unused" }),
      drainCompletedShellProducedFiles: async () => [],
      killShell: async () => {},
    },
  } as unknown as RunnerContext;
  createAgentOrchestration(context, {
    buildAgentContext: async ({ threadId, modelConfigSnapshot }) => {
      fetchedModelConfigs.push(modelConfigSnapshot);
      return {
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 2,
        // The shipped General allowlist. The manager prunes the orchestration
        // tools from it for a parent-owned thread, which is what the
        // two-tier exposure test below observes.
        toolsAllowlist: [
          "exec_command",
          "apply_patch",
          "web",
          "spawn_agent",
          "send_input",
          "pause_agent",
        ],
        // Mirrors buildAgentContext's real non-orchestrator history hydration.
        // Keeping this wired to SessionStore is what exposes replay duplicates
        // and is how a woken parent actually sees its subagent's report.
        threadHistory: store.loadThreadMessages(threadId),
        resolvedLlm: {
          model: { id: "test-model", provider: "openai" },
        },
      };
    },
    sendMessage: async (message) => {
      sentMessages.push(message);
    },
    ...(options?.attemptTeardownTimeoutMs !== undefined
      ? { attemptTeardownTimeoutMs: options.attemptTeardownTimeoutMs }
      : {}),
  });
  const harness = {
    rootPath,
    db,
    store,
    manager: context.state.localAgentManager!,
    appendedEvents,
    sentMessages,
    streamedAgentEvents,
    fetchedModelConfigs,
  };
  harnesses.add(harness);
  return harness;
};

const closeHarness = async (
  harness: Harness,
  options?: { removeRoot?: boolean },
) => {
  harness.manager.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  harness.db.close();
  harnesses.delete(harness);
  if (options?.removeRoot !== false) {
    await rm(harness.rootPath, { recursive: true, force: true });
  }
};

afterEach(async () => {
  runMock.handler = null;
  for (const harness of harnesses) {
    await closeHarness(harness);
  }
  harnesses.clear();
  vi.clearAllMocks();
});

describe("subagent orchestration production routing", () => {
  it("routes an exhausted top-level failure as a structured orchestrator event", async () => {
    const { manager, appendedEvents, sentMessages, streamedAgentEvents } =
      createHarness();
    let attempts = 0;
    runMock.handler = async (args) => {
      const retried = await executeAgentTurnWithRetry({
        execute: async () => {
          attempts += 1;
          return { finalText: "", errorMessage: "500 Server Error" };
        },
        prepareRetry: () => true,
        onRetry: (info) =>
          args.callbacks?.onStatus?.({
            statusState: "provider-retry",
            statusText: `Retrying attempt ${info.attempt} of ${info.maxAttempts}`,
          }),
        random: () => 0.5,
        sleep: async () => undefined,
      });
      return {
        runId: "top-level-exhausted",
        result: retried.finalText,
        ...(retried.errorMessage ? { error: retried.errorMessage } : {}),
      };
    };

    const task = await manager.createAgent({
      conversationId: "conversation-top-level-failure",
      rootRunId: "root-filter-run",
      description: "Top-level transient failure",
      prompt: "Retry and report failure if recovery exhausts.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(
      async () => (await manager.getAgent(task.threadId))?.status === "error",
    );

    expect(attempts).toBe(4);
    expect(
      streamedAgentEvents.filter(
        (event) =>
          event.type === "agent-progress" &&
          event.agentId === task.threadId &&
          event.statusText?.startsWith("Retrying attempt"),
      ),
    ).toHaveLength(3);
    expect(JSON.stringify(appendedEvents)).not.toContain("Retrying attempt");
    expect(JSON.stringify(sentMessages)).not.toContain("Retrying attempt");
    expect(appendedEvents).toContainEqual(
      expect.objectContaining({
        type: "agent-failed",
        eventId: `${task.threadId}:1:agent-failed`,
        payload: expect.objectContaining({
          agentId: task.threadId,
          attemptGeneration: 1,
          error: expect.stringContaining(
            "Automatic recovery exhausted after 4 attempts (http_5xx)",
          ),
        }),
      }),
    );
    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("[Task failed]"),
        responseTarget: expect.objectContaining({
          type: "agent_turn",
          agentId: task.threadId,
        }),
      }),
    );
  });

  it("delivers a subagent's full final report into the woken parent's next turn, with no root card and no notification", async () => {
    const {
      manager,
      store,
      appendedEvents,
      sentMessages,
      streamedAgentEvents,
    } = createHarness();
    let releaseParentFirst!: () => void;
    const parentFirstGate = new Promise<void>((resolve) => {
      releaseParentFirst = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    // Long enough that a capped relay would visibly truncate it.
    const childReport = [
      "Subagent final report.",
      "what changed: rewrote the loader and deleted the legacy shim.",
      "outcome: all 42 fixtures pass.",
      "blockers: none, but the nightly job still pins the old flag.",
    ].join("\n");
    const parentRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentId?.startsWith("parent")) {
        parentRuns.push(args);
        if (parentRuns.length === 1) {
          await parentFirstGate;
          return {
            runId: "parent-1",
            result: "Parent turn one; the subagent is still working.",
          };
        }
        return {
          runId: "parent-2",
          result: "Parent consolidated the subagent report.",
        };
      }
      await childGate;
      return { runId: "child-1", result: childReport };
    };

    const parentTask = await manager.createAgent({
      conversationId: "conversation-child-wake",
      rootRunId: "root-filter-run",
      description: "Parent wake coordination",
      prompt: "Spawn one subagent and consolidate its report.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      conversationId: "conversation-child-wake",
      rootRunId: "root-filter-run",
      description: "Sub wake verification",
      prompt: "Verify the claim and report back.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: parentTask.threadId,
      storageMode: "local",
    });

    // The normal shape: the parent finishes its turn and goes idle BEFORE the
    // subagent lands. The child report has to resurrect it.
    releaseParentFirst();
    await waitUntil(
      async () =>
        (await manager.getAgent(parentTask.threadId))?.status === "completed",
    );
    const rootEventsBeforeChild = appendedEvents.length;
    const streamedBeforeChild = streamedAgentEvents.length;

    releaseChild();
    await waitUntil(
      async () =>
        parentRuns.length === 2 &&
        (await manager.getAgent(parentTask.threadId))?.status === "completed",
    );

    // 1. The parent actually re-ran, and its next turn saw the child's FULL
    //    report — not a truncation, and not merely the pointer.
    const wokenTurn = parentRuns[1]!;
    expect(wokenTurn.userPrompt).toContain(CHILD_REPORT_WAKE_INPUT);
    expect(wokenTurn.userPrompt).not.toContain("Subagent final report.");
    expect(historyText(wokenTurn)).toContain(childReport);
    expect(historyText(wokenTurn)).toContain("[Agent completed]");
    expect(historyText(wokenTurn)).toContain(PARENT_TERMINAL_REMINDER);
    expect(historyText(wokenTurn)).toContain(
      "It is delivered to you alone — it does not reach the user.",
    );
    // The parent-recipient framing, not the orchestrator's canvas framing.
    expect(historyText(wokenTurn)).not.toContain("presentation:");
    expect(threadHistoryText(store, parentTask.threadId)).toContain(
      childReport,
    );

    // 2. No root leakage: no root chat card and no run-callback event (the
    //    path that fires the OS notification) for the subagent, ever.
    expect(
      appendedEvents.filter(
        (event) =>
          (event.payload as { agentId?: string }).agentId ===
          childTask.threadId,
      ),
    ).toEqual([]);
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId ===
            childTask.threadId,
      ),
    ).toBe(false);
    expect(
      streamedAgentEvents.filter(
        (event) => event.agentId === childTask.threadId,
      ),
    ).toEqual([]);
    expect(JSON.stringify(appendedEvents)).not.toContain(childTask.threadId);
    expect(JSON.stringify(appendedEvents)).not.toContain(childReport);
    expect(JSON.stringify(sentMessages)).not.toContain(childTask.threadId);
    expect(JSON.stringify(sentMessages)).not.toContain(childReport);
    // The callback wiring is live for this run id, so the emptiness above is
    // routing, not a dead harness.
    expect(
      streamedAgentEvents.filter(
        (event) =>
          event.type === "agent-started" &&
          event.agentId === parentTask.threadId,
      ),
    ).toHaveLength(1);

    // 3. Internal coordination must not look like a new top-level send_input:
    //    the woken re-entry emits neither agent-started nor agent-progress.
    expect(
      appendedEvents
        .slice(rootEventsBeforeChild)
        .filter((event) => event.type === "agent-started"),
    ).toEqual([]);
    expect(
      streamedAgentEvents
        .slice(streamedBeforeChild)
        .filter(
          (event) =>
            event.type === "agent-started" || event.type === "agent-progress",
        ),
    ).toEqual([]);

    // The parent's own completions still reach root, once per finished turn.
    expect(
      appendedEvents
        .filter(
          (event) =>
            event.type === "agent-completed" &&
            (event.payload as { agentId?: string }).agentId ===
              parentTask.threadId,
        )
        .map((event) => (event.payload as { result?: string }).result),
    ).toEqual([
      "Parent turn one; the subagent is still working.",
      "Parent consolidated the subagent report.",
    ]);
  });

  it.each([
    {
      caseName: "persistent empty completions",
      createMessage: emptyAssistantMessage,
    },
    {
      caseName: "persistent silent length truncations",
      createMessage: silentLengthTruncationMessage,
    },
  ])(
    "routes exhausted $caseName only to the owning parent agent",
    async ({ createMessage }) => {
      const { manager, store, appendedEvents, sentMessages } = createHarness();
      let releaseParentFirst!: () => void;
      const parentFirstGate = new Promise<void>((resolve) => {
        releaseParentFirst = resolve;
      });
      let releaseChild!: () => void;
      const childGate = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      const parentRuns: MockRunArgs[] = [];
      let childProviderCalls = 0;

      runMock.handler = async (args) => {
        if (args.agentId?.startsWith("parent")) {
          parentRuns.push(args);
          if (parentRuns.length === 1) {
            await parentFirstGate;
            return {
              runId: "parent-wait",
              result: "Parent turn one; waiting for the subagent.",
            };
          }
          expect(historyText(args)).toContain("[Task failed]");
          expect(historyText(args)).toContain(
            "Automatic recovery exhausted after 4 attempts",
          );
          expect(historyText(args)).toContain("(empty_response)");
          return {
            runId: "parent-adapted",
            result: "Parent adapted after the subagent retry failure.",
          };
        }

        await childGate;
        const session = new RetryTestSession();
        const agent = createRuntimeAgent({
          agentType: AGENT_IDS.GENERAL,
          systemPrompt: "",
          resolvedLlm: {
            model: emptyResponseModel,
            route: "test",
            getApiKey: () => undefined,
          },
          tools: [],
          historySource: [],
        });
        agent.streamFn = () => {
          childProviderCalls += 1;
          const stream = createAssistantMessageEventStream();
          const message = createMessage();
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", message });
          return stream;
        };
        const recorder = {
          recordQueuedUserMessageStart: () => null,
          recordAssistantMessageEnd: () => null,
        } as never;
        const retried = await executeAgentTurnWithRetry({
          execute: async (resume) =>
            executeRuntimeAgentPrompt({
              agent,
              promptText: "Return a non-empty child result.",
              runId: "child-empty-response",
              agentType: AGENT_IDS.GENERAL,
              userMessageId: "child-empty-response-user",
              recorder,
              abortSignal: args.abortSignal,
              resume,
            }),
          prepareRetry: (failure) => session.prepareRetry(agent, failure),
          signal: args.abortSignal,
          random: () => 0.5,
          sleep: async () => undefined,
        });
        return {
          runId: "child-exhausted",
          result: retried.finalText,
          ...(retried.errorMessage ? { error: retried.errorMessage } : {}),
        };
      };

      const parentTask = await manager.createAgent({
        conversationId: "conversation-owner-failure",
        description: "Parent owning a retrying subagent",
        prompt: "Adapt if the subagent fails.",
        agentType: AGENT_IDS.GENERAL,
        agentDepth: 1,
        storageMode: "local",
      });
      const childTask = await manager.createAgent({
        conversationId: "conversation-owner-failure",
        description: "Sub transient failure",
        prompt: "Retry transient transport failures.",
        agentType: AGENT_IDS.GENERAL,
        agentDepth: 2,
        maxAgentDepth: 2,
        parentAgentId: parentTask.threadId,
        storageMode: "local",
      });

      releaseParentFirst();
      await waitUntil(
        async () =>
          (await manager.getAgent(parentTask.threadId))?.status === "completed",
      );
      releaseChild();
      await waitUntil(
        async () =>
          (await manager.getAgent(childTask.threadId))?.status === "error",
      );
      await waitUntil(
        async () =>
          parentRuns.length === 2 &&
          (await manager.getAgent(parentTask.threadId))?.status === "completed",
      );

      expect(childProviderCalls).toBe(4);
      const parentHistory = store.loadThreadMessages(parentTask.threadId);
      expect(
        parentHistory.filter((message) =>
          message.customMessage?.content.some(
            (block) =>
              block.type === "text" &&
              block.text.includes(
                "Automatic recovery exhausted after 4 attempts",
              ),
          ),
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(appendedEvents)).not.toContain(childTask.threadId);
      expect(JSON.stringify(sentMessages)).not.toContain(childTask.threadId);
      expect(JSON.stringify(sentMessages)).not.toContain("empty_response");
      expect(JSON.stringify(appendedEvents)).toContain(parentTask.threadId);
      expect(JSON.stringify(sentMessages)).toContain(
        "Parent adapted after the subagent retry failure.",
      );
    },
  );

  it("keeps subagent starts, follow-ups, and terminal reminders out of the root transcript", async () => {
    const {
      rootPath,
      manager,
      store,
      appendedEvents,
      sentMessages,
      streamedAgentEvents,
    } = createHarness();
    let releaseParentFirst!: () => void;
    const parentFirstGate = new Promise<void>((resolve) => {
      releaseParentFirst = resolve;
    });
    let releaseFirstChild!: () => void;
    const firstChildGate = new Promise<void>((resolve) => {
      releaseFirstChild = resolve;
    });
    let releaseFirstChildFollowUp!: () => void;
    const firstChildFollowUpGate = new Promise<void>((resolve) => {
      releaseFirstChildFollowUp = resolve;
    });
    let releaseSecondChild!: () => void;
    const secondChildGate = new Promise<void>((resolve) => {
      releaseSecondChild = resolve;
    });
    const parentRuns: MockRunArgs[] = [];
    const parentResults = [
      "Parent spawned two subagents.",
      "Parent recorded the first subagent report.",
      "Parent recorded the first subagent follow-up.",
      "Parent consolidated both subagents.",
    ];
    const childRunCounts = new Map<string, number>();

    runMock.handler = async (args) => {
      if (args.agentId?.startsWith("parent")) {
        parentRuns.push(args);
        if (parentRuns.length === 1) {
          await parentFirstGate;
        }
        return {
          runId: `parent-${parentRuns.length}`,
          result:
            parentResults[parentRuns.length - 1] ?? "Parent extra turn result.",
        };
      }

      const agentId = args.agentId ?? "missing-child";
      const runCount = (childRunCounts.get(agentId) ?? 0) + 1;
      childRunCounts.set(agentId, runCount);
      if (agentId.startsWith("first-sub")) {
        if (runCount === 1) {
          await firstChildGate;
          return {
            runId: "first-child",
            result: "First subagent private result.",
          };
        }
        await firstChildFollowUpGate;
        return {
          runId: "first-child-follow-up",
          result: "First subagent private follow-up result.",
        };
      }
      if (agentId.startsWith("second-sub")) {
        await secondChildGate;
        return {
          runId: "second-child",
          result: "Second subagent private result.",
        };
      }
      return { runId: "standalone", result: "Standalone direct result." };
    };

    const parentTask = await manager.createAgent({
      conversationId: "conversation-root-filter",
      description: "Parent coordinating two private subagents",
      prompt: "Coordinate both subagents and return one consolidated response.",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-filter-run",
      agentDepth: 1,
      storageMode: "local",
    });
    const firstChild = await manager.createAgent({
      conversationId: "conversation-root-filter",
      description: "First sub verification",
      prompt: "Run the first verification.",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-filter-run",
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: parentTask.threadId,
      storageMode: "local",
    });
    const secondChild = await manager.createAgent({
      conversationId: "conversation-root-filter",
      description: "Second sub verification",
      prompt: "Run the second verification.",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-filter-run",
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: parentTask.threadId,
      storageMode: "local",
    });

    releaseParentFirst();
    await waitUntil(
      async () =>
        parentRuns.length === 1 &&
        (await manager.getAgent(parentTask.threadId))?.status === "completed",
    );

    releaseFirstChild();
    await waitUntil(
      async () =>
        parentRuns.length === 2 &&
        (await manager.getAgent(parentTask.threadId))?.status === "completed",
    );

    // A parent steering its own subagent: an explicit send_input follow-up on
    // a thread that has already gone terminal.
    await handleSendInput(
      {
        stateRoot: "/tmp",
        tasks: new Map(),
        agentApi: manager,
      },
      {
        thread_id: firstChild.threadId,
        description: "Recheck first subagent",
        message: "Recheck the first result before consolidation.",
      },
      {
        conversationId: "conversation-root-filter",
        deviceId: "device-subagent-test",
        requestId: "parent-child-follow-up",
        agentType: AGENT_IDS.GENERAL,
        agentId: parentTask.threadId,
        storageMode: "local",
      },
    );
    releaseFirstChildFollowUp();
    await waitUntil(
      async () =>
        parentRuns.length === 3 &&
        (await manager.getAgent(parentTask.threadId))?.status === "completed",
    );

    releaseSecondChild();
    await waitUntil(
      async () =>
        parentRuns.length === 4 &&
        (await manager.getAgent(parentTask.threadId))?.status === "completed",
    );

    const rootLifecycle = appendedEvents.filter((event) =>
      [
        "agent-started",
        "agent-completed",
        "agent-failed",
        "agent-canceled",
      ].includes(event.type),
    );
    // Only the parent is ever projected into root: one start (spawn) and one
    // completion per finished turn. Child-report re-entries emit no start.
    expect(
      rootLifecycle.every(
        (event) =>
          (event.payload as { agentId?: string }).agentId ===
          parentTask.threadId,
      ),
    ).toBe(true);
    expect(
      rootLifecycle.filter((event) => event.type === "agent-started"),
    ).toHaveLength(1);
    expect(
      rootLifecycle
        .filter((event) => event.type === "agent-completed")
        .map((event) => (event.payload as { result?: string }).result),
    ).toEqual(parentResults);
    const lastCompletion = rootLifecycle[rootLifecycle.length - 1]!;
    expect(
      store.hasEvent(
        "conversation-root-filter",
        lastCompletion.eventId ?? "",
        "agent-completed",
      ),
    ).toBe(true);
    expect(
      store
        .loadThreadMessages("conversation-root-filter")
        .some(
          (message) =>
            message.customMessage?.customType === "runtime.task_lifecycle" &&
            message.customMessage.eventId === lastCompletion.eventId,
        ),
    ).toBe(true);
    expect(lastCompletion.eventId).toMatch(
      new RegExp(`^${parentTask.threadId}:\\d+:agent-completed$`),
    );
    expect(JSON.stringify(appendedEvents)).not.toContain(
      PARENT_TERMINAL_REMINDER,
    );
    expect(JSON.stringify(appendedEvents)).not.toContain(firstChild.threadId);
    expect(JSON.stringify(appendedEvents)).not.toContain(secondChild.threadId);
    expect(
      streamedAgentEvents.filter(
        (event) =>
          event.agentId === firstChild.threadId ||
          event.agentId === secondChild.threadId,
      ),
    ).toEqual([]);
    expect(
      streamedAgentEvents.filter(
        (event) =>
          event.type === "agent-started" &&
          event.agentId === parentTask.threadId,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(streamedAgentEvents)).not.toContain(
      PARENT_TERMINAL_REMINDER,
    );
    expect(
      sentMessages.some((message) =>
        message.text.includes("First subagent private result."),
      ),
    ).toBe(false);
    expect(
      sentMessages.some((message) =>
        message.text.includes("Second subagent private result."),
      ),
    ).toBe(false);

    const parentHistory = threadHistoryText(store, parentTask.threadId);
    expect(parentHistory).toContain("First subagent private result.");
    expect(parentHistory).toContain("First subagent private follow-up result.");
    expect(parentHistory).toContain("Second subagent private result.");

    const privateLifecycle = readThreadLifecycleRows(
      rootPath,
      parentTask.threadId,
    );
    const privateTaskCards = privateLifecycle
      .filter((event) =>
        ["agent-started", "agent-completed"].includes(event.type),
      )
      .map((event) => ({
        id: event._id,
        type: event.type,
        agentId: event.payload?.agentId,
        attemptGeneration: event.payload?.attemptGeneration,
        isFollowUp: event.payload?.isFollowUp,
      }));
    expect(privateTaskCards).toEqual([
      {
        id: `${firstChild.threadId}:1:agent-started`,
        type: "agent-started",
        agentId: firstChild.threadId,
        attemptGeneration: 1,
        isFollowUp: undefined,
      },
      {
        id: `${secondChild.threadId}:1:agent-started`,
        type: "agent-started",
        agentId: secondChild.threadId,
        attemptGeneration: 1,
        isFollowUp: undefined,
      },
      {
        id: `${firstChild.threadId}:1:agent-completed`,
        type: "agent-completed",
        agentId: firstChild.threadId,
        attemptGeneration: 1,
        isFollowUp: undefined,
      },
      {
        id: expect.stringMatching(
          new RegExp(`^${firstChild.threadId}:\\d+:agent-started$`),
        ),
        type: "agent-started",
        agentId: firstChild.threadId,
        attemptGeneration: expect.any(Number),
        isFollowUp: true,
      },
      {
        id: expect.stringMatching(
          new RegExp(`^${firstChild.threadId}:\\d+:agent-completed$`),
        ),
        type: "agent-completed",
        agentId: firstChild.threadId,
        attemptGeneration: expect.any(Number),
        isFollowUp: undefined,
      },
      {
        id: `${secondChild.threadId}:1:agent-completed`,
        type: "agent-completed",
        agentId: secondChild.threadId,
        attemptGeneration: 1,
        isFollowUp: undefined,
      },
    ]);
    const followUpStart = privateTaskCards[3]!;
    const followUpCompletion = privateTaskCards[4]!;
    expect(followUpStart.attemptGeneration).toBeGreaterThan(1);
    expect(followUpCompletion.attemptGeneration).toBe(
      followUpStart.attemptGeneration,
    );
    expect(followUpStart.id).toBe(
      `${firstChild.threadId}:${followUpStart.attemptGeneration}:agent-started`,
    );
    expect(followUpCompletion.id).toBe(
      `${firstChild.threadId}:${followUpStart.attemptGeneration}:agent-completed`,
    );
    expect(
      privateTaskCards.every((card) => card.agentId !== parentTask.threadId),
    ).toBe(true);
    expect(JSON.stringify(privateLifecycle)).not.toMatch(
      /spawn_agent|send_input|\[Tool call\]|\[Tool result\]/,
    );
    const activityIds = store
      .listThreadActivity("conversation-root-filter")
      .map((record) => record.threadId);
    expect(activityIds).toEqual(
      expect.arrayContaining([
        parentTask.threadId,
        firstChild.threadId,
        secondChild.threadId,
      ]),
    );

    // A root-spawned agent (no parent) is the ONLY case that reaches root.
    const standalone = await manager.createAgent({
      conversationId: "conversation-root-filter",
      description: "Standalone direct verification",
      prompt: "Run directly for the orchestrator.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(standalone.threadId))?.status === "completed",
    );
    expect(
      appendedEvents.filter(
        (event) =>
          (event.payload as { agentId?: string }).agentId ===
          standalone.threadId,
      ),
    ).toEqual([
      expect.objectContaining({ type: "agent-started" }),
      expect.objectContaining({ type: "agent-completed" }),
    ]);
  });

  it("projects subagent failure and cancellation cards from production lifecycle events only", async () => {
    const harness = createHarness();
    const { manager, appendedEvents, sentMessages } = harness;
    let releaseParentFirst!: () => void;
    const parentFirstGate = new Promise<void>((resolve) => {
      releaseParentFirst = resolve;
    });
    let releaseFailingChild!: () => void;
    const failingChildGate = new Promise<void>((resolve) => {
      releaseFailingChild = resolve;
    });
    const parentRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentId?.startsWith("parent")) {
        parentRuns.push(args);
        if (parentRuns.length === 1) {
          await parentFirstGate;
        }
        return {
          runId: `parent-private-terminal-${parentRuns.length}`,
          result: "Parent noted a private terminal subagent event.",
        };
      }
      if (args.agentId?.startsWith("failing-sub")) {
        await failingChildGate;
        throw new Error("Private subagent failure.");
      }
      await waitForAbort(args.abortSignal);
      return { runId: "canceled-child", result: "", interrupted: true };
    };

    const parentTask = await manager.createAgent({
      conversationId: "conversation-private-terminal-cards",
      description: "Parent coordinating private terminal cards",
      prompt: "Wait for both private subagents.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const failedChild = await manager.createAgent({
      conversationId: "conversation-private-terminal-cards",
      description: "Failing sub",
      prompt: "Fail in the test runtime.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: parentTask.threadId,
      storageMode: "local",
    });
    const canceledChild = await manager.createAgent({
      conversationId: "conversation-private-terminal-cards",
      description: "Canceled sub",
      prompt: "Wait to be canceled.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: parentTask.threadId,
      storageMode: "local",
    });

    releaseParentFirst();
    await waitUntil(
      async () =>
        (await manager.getAgent(parentTask.threadId))?.status === "completed",
    );
    releaseFailingChild();
    await waitUntil(
      async () =>
        (await manager.getAgent(failedChild.threadId))?.status === "error",
    );
    await waitUntil(
      async () =>
        (await manager.getAgent(canceledChild.threadId))?.status === "running",
    );
    await manager.cancelAgent(
      canceledChild.threadId,
      "Canceled for private lifecycle regression.",
    );
    await waitUntil(
      async () =>
        (await manager.getAgent(canceledChild.threadId))?.status === "canceled",
    );
    // Both terminal reports wake the parent; let it settle before reading.
    await waitUntil(
      async () =>
        parentRuns.length >= 2 &&
        !hasInFlightAttempt(manager, parentTask.threadId),
    );

    const privateLifecycle = readThreadLifecycleRows(
      harness.rootPath,
      parentTask.threadId,
    );

    expect(
      privateLifecycle
        .filter((event) =>
          ["agent-started", "agent-failed", "agent-canceled"].includes(
            event.type,
          ),
        )
        .map((event) => ({
          id: event._id,
          type: event.type,
          agentId: event.payload?.agentId,
          error: event.payload?.error,
        })),
    ).toEqual([
      {
        id: `${failedChild.threadId}:1:agent-started`,
        type: "agent-started",
        agentId: failedChild.threadId,
        error: undefined,
      },
      {
        id: `${canceledChild.threadId}:1:agent-started`,
        type: "agent-started",
        agentId: canceledChild.threadId,
        error: undefined,
      },
      {
        id: `${failedChild.threadId}:1:agent-failed`,
        type: "agent-failed",
        agentId: failedChild.threadId,
        error: "Private subagent failure.",
      },
      {
        id: `${canceledChild.threadId}:1:agent-canceled`,
        type: "agent-canceled",
        agentId: canceledChild.threadId,
        error: "Canceled for private lifecycle regression.",
      },
    ]);
    expect(JSON.stringify(appendedEvents)).not.toContain(failedChild.threadId);
    expect(JSON.stringify(appendedEvents)).not.toContain(
      canceledChild.threadId,
    );
    expect(JSON.stringify(sentMessages)).not.toContain(
      "Private subagent failure.",
    );
    expect(JSON.stringify(sentMessages)).not.toContain(
      "Canceled for private lifecycle regression.",
    );
  });

  it("routes a grandchild report to its direct parent, never to root or the grandparent", async () => {
    const {
      manager,
      store,
      appendedEvents,
      sentMessages,
      streamedAgentEvents,
    } = createHarness();
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    let releaseMid!: () => void;
    const midGate = new Promise<void>((resolve) => {
      releaseMid = resolve;
    });
    let releaseLeaf!: () => void;
    const leafGate = new Promise<void>((resolve) => {
      releaseLeaf = resolve;
    });
    const leafReport = "Grandchild private terminal report.";
    const parentRuns: MockRunArgs[] = [];
    const midRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentId?.startsWith("parent")) {
        parentRuns.push(args);
        if (parentRuns.length === 1) await parentGate;
        return {
          runId: `parent-ancestry-${parentRuns.length}`,
          result: "Parent absorbed a direct-child report.",
        };
      }
      if (args.agentId?.startsWith("mid")) {
        midRuns.push(args);
        if (midRuns.length === 1) {
          await midGate;
          return { runId: "mid-1", result: "Mid turn one result." };
        }
        return {
          runId: `mid-${midRuns.length}`,
          result: "Mid folded in the grandchild outcome.",
        };
      }
      await leafGate;
      return { runId: "leaf-1", result: leafReport };
    };

    const parentTask = await manager.createAgent({
      conversationId: "conversation-transitive-routing",
      rootRunId: "root-filter-run",
      description: "Parent ancestry root",
      prompt: "Coordinate nested work.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      maxAgentDepth: 3,
      storageMode: "local",
    });
    const child = await manager.createAgent({
      conversationId: "conversation-transitive-routing",
      rootRunId: "root-filter-run",
      description: "Mid ancestry agent",
      prompt: "Own nested work.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 3,
      parentAgentId: parentTask.threadId,
      storageMode: "local",
    });
    const grandchild = await manager.createAgent({
      conversationId: "conversation-transitive-routing",
      rootRunId: "root-filter-run",
      description: "Leaf ancestry agent",
      prompt: "Return a private report.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 3,
      maxAgentDepth: 3,
      parentAgentId: child.threadId,
      storageMode: "local",
    });

    // Ownership is the DIRECT parent at every level; only a root-spawned
    // agent resolves to undefined (the sole path to root chat).
    expect(
      manager.resolveOwningParentThread(grandchild.threadId, child.threadId),
    ).toBe(child.threadId);
    expect(manager.resolveOwningParentThread(grandchild.threadId)).toBe(
      child.threadId,
    );
    expect(manager.resolveOwningParentThread(child.threadId)).toBe(
      parentTask.threadId,
    );
    expect(
      manager.resolveOwningParentThread(parentTask.threadId),
    ).toBeUndefined();

    releaseParent();
    await waitUntil(
      async () =>
        parentRuns.length === 1 &&
        (await manager.getAgent(parentTask.threadId))?.status === "completed",
    );
    releaseMid();
    await waitUntil(
      async () =>
        (await manager.getAgent(child.threadId))?.status === "completed" &&
        parentRuns.length === 2 &&
        (await manager.getAgent(parentTask.threadId))?.status === "completed",
    );
    releaseLeaf();
    await waitUntil(
      async () =>
        (await manager.getAgent(grandchild.threadId))?.status === "completed" &&
        midRuns.length === 2 &&
        (await manager.getAgent(child.threadId))?.status === "completed",
    );

    // The grandchild's report landed in its direct parent's thread only.
    expect(threadHistoryText(store, child.threadId)).toContain(leafReport);
    expect(historyText(midRuns[1]!)).toContain(leafReport);
    expect(threadHistoryText(store, parentTask.threadId)).not.toContain(
      leafReport,
    );
    expect(threadHistoryText(store, parentTask.threadId)).toContain(
      "Mid folded in the grandchild outcome.",
    );
    expect(JSON.stringify(appendedEvents)).not.toContain(grandchild.threadId);
    expect(JSON.stringify(appendedEvents)).not.toContain(child.threadId);
    expect(JSON.stringify(appendedEvents)).not.toContain(leafReport);
    expect(JSON.stringify(sentMessages)).not.toContain(leafReport);
    expect(
      streamedAgentEvents.filter(
        (event) =>
          event.agentId === grandchild.threadId ||
          event.agentId === child.threadId,
      ),
    ).toEqual([]);
    expect(
      store
        .listThreadActivity("conversation-transitive-routing")
        .map((record) => record.threadId),
    ).toEqual(
      expect.arrayContaining([
        parentTask.threadId,
        child.threadId,
        grandchild.threadId,
      ]),
    );

    // A dangling parent link is dropped outright — never guessed into root.
    // Asserted by identity rather than by a total count: unrelated events from
    // the fleet above can still be settling, and an exact length here would
    // race with them under load rather than testing this event.
    const danglingResult = "Must not escape to root.";
    productionEventHandlerOf(manager)({
      type: "agent-completed",
      conversationId: "conversation-transitive-routing",
      eventId: "legacy-missing-parent-completion",
      agentId: "legacy-missing-child",
      agentType: AGENT_IDS.GENERAL,
      description: "Legacy missing child",
      parentAgentId: "missing-parent-link",
      result: danglingResult,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(JSON.stringify(appendedEvents)).not.toContain(
      "legacy-missing-child",
    );
    expect(JSON.stringify(appendedEvents)).not.toContain(danglingResult);
    expect(JSON.stringify(sentMessages)).not.toContain("legacy-missing-child");
    expect(JSON.stringify(sentMessages)).not.toContain(danglingResult);
    expect(
      streamedAgentEvents.filter(
        (event) => event.agentId === "legacy-missing-child",
      ),
    ).toEqual([]);
    expect(
      manager.resolveOwningParentThread(
        "legacy-missing-child",
        "missing-parent-link",
      ),
    ).toBeNull();

    // A self-cyclic parent link is unattributable for the same reason.
    expect(
      manager.resolveOwningParentThread(
        grandchild.threadId,
        grandchild.threadId,
      ),
    ).toBeNull();
    const taskRecords = (
      manager as unknown as {
        tasks: Map<string, { parentAgentId?: string }>;
      }
    ).tasks;
    taskRecords.get(grandchild.threadId)!.parentAgentId = grandchild.threadId;
    expect(manager.resolveOwningParentThread(grandchild.threadId)).toBeNull();

    // A mutual two-node cycle is just as unattributable: routing a report to
    // a "parent" that is also its own descendant would loop the delivery.
    // Only a full walk to the root catches this — a direct-parent existence
    // check alone would happily return a live thread here.
    taskRecords.get(child.threadId)!.parentAgentId = grandchild.threadId;
    taskRecords.get(grandchild.threadId)!.parentAgentId = child.threadId;
    expect(manager.resolveOwningParentThread(grandchild.threadId)).toBeNull();
    expect(manager.resolveOwningParentThread(child.threadId)).toBeNull();
  });

  it("withholds the orchestration tools from a parent-owned run's toolset", async () => {
    const { manager } = createHarness();
    const allowlistByThread = new Map<string, string[] | undefined>();
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    runMock.handler = async (args) => {
      allowlistByThread.set(
        args.agentId ?? "",
        args.agentContext?.toolsAllowlist,
      );
      if (args.agentId === "tier-parent") {
        await parentGate;
        return { runId: "tier-parent-1", result: "Parent done." };
      }
      return { runId: "tier-sub-1", result: "Subagent done." };
    };

    const parentTask = await manager.createAgent({
      conversationId: "conversation-tool-tiers",
      description: "Tier parent",
      prompt: "Coordinate.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      maxAgentDepth: 2,
      storageMode: "local",
    });
    const subTask = await manager.createAgent({
      conversationId: "conversation-tool-tiers",
      description: "Tier sub",
      prompt: "Execute.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: parentTask.threadId,
      storageMode: "local",
    });
    await waitUntil(() => allowlistByThread.has(subTask.threadId));
    releaseParent();
    await waitUntil(() => allowlistByThread.has(parentTask.threadId));

    const parentAllowlist = allowlistByThread.get(parentTask.threadId) ?? [];
    const subAllowlist = allowlistByThread.get(subTask.threadId) ?? [];
    const orchestrationTools = ["spawn_agent", "send_input", "pause_agent"];

    // A root-spawned General keeps them; a parent-owned one does not.
    expect(parentAllowlist).toEqual(expect.arrayContaining(orchestrationTools));
    for (const toolName of orchestrationTools) {
      expect(subAllowlist).not.toContain(toolName);
    }
    // Everything else is identical — a subagent is a full General otherwise.
    expect(subAllowlist.slice().sort()).toEqual(
      parentAllowlist
        .filter((name) => !orchestrationTools.includes(name))
        .sort(),
    );
  });

  it("refuses a depth-2 subagent's spawn while allowing a depth-1 parent to spawn", async () => {
    const { manager, store } = createHarness();
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    runMock.handler = async (args) => {
      if (args.agentId?.startsWith("parent")) {
        await parentGate;
        return { runId: "parent-depth", result: "Parent depth turn done." };
      }
      return { runId: "child-depth", result: "Subagent depth turn done." };
    };

    const parentTask = await manager.createAgent({
      conversationId: "conversation-depth-cap",
      description: "Parent depth holder",
      prompt: "Spawn one subagent.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      maxAgentDepth: 2,
      storageMode: "local",
    });

    const stateContext = {
      stateRoot: "/tmp",
      tasks: new Map(),
      agentApi: manager,
    };
    // Orchestrator -> General(depth 1) -> subagent(depth 2) is allowed.
    const allowed = await handleSpawnAgent(
      stateContext,
      {
        description: "Depth two sub",
        prompt: "Do the depth-two work.",
      },
      {
        conversationId: "conversation-depth-cap",
        deviceId: "device-subagent-test",
        requestId: "spawn-depth-2",
        agentType: AGENT_IDS.GENERAL,
        agentId: parentTask.threadId,
        agentDepth: 1,
        maxAgentDepth: 2,
        storageMode: "local",
      },
    );
    expect(allowed.error).toBeUndefined();
    const childThreadId = (allowed.result as { thread_id: string }).thread_id;
    await waitUntil(
      async () =>
        (await manager.getAgent(childThreadId))?.status === "completed",
    );
    expect(store.getAgentRecord(childThreadId)).toMatchObject({
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: parentTask.threadId,
      agentType: AGENT_IDS.GENERAL,
    });

    // The depth-2 subagent cannot spawn again.
    const refused = await handleSpawnAgent(
      stateContext,
      {
        description: "Depth three sub",
        prompt: "Try to go one level deeper.",
      },
      {
        conversationId: "conversation-depth-cap",
        deviceId: "device-subagent-test",
        requestId: "spawn-depth-3",
        agentType: AGENT_IDS.GENERAL,
        agentId: childThreadId,
        agentDepth: 2,
        maxAgentDepth: 2,
        storageMode: "local",
      },
    );
    expect(refused.result).toBeUndefined();
    expect(refused.error).toBe(
      "Task depth limit reached (2). Complete work in the current task instead of creating another subtask.",
    );
    expect(
      store
        .listThreadActivity("conversation-depth-cap")
        .filter((record) => record.threadId !== parentTask.threadId)
        .map((record) => record.threadId),
    ).toEqual([childThreadId]);
    releaseParent();
  });

  it("re-enters a completed parent with start and progress events for an external send_input", async () => {
    const { manager, appendedEvents, sentMessages, streamedAgentEvents } =
      createHarness();
    const parentRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      parentRuns.push(args);
      if (parentRuns.length === 1) {
        return {
          runId: "terminal-first",
          result: "Original process complete.",
        };
      }
      return {
        runId: "terminal-status-follow-up",
        result: "The original process was already complete.",
      };
    };

    const task = await manager.createAgent({
      conversationId: "conversation-terminal-status",
      rootRunId: "root-filter-run",
      description: "Complete parent work",
      prompt: "Complete the work now.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(task.threadId))?.status === "completed",
    );
    await manager.sendAgentMessage(
      task.threadId,
      "Give me a status update.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(
      async () =>
        parentRuns.length === 2 &&
        (await manager.getAgent(task.threadId))?.status === "completed",
    );

    expect(parentRuns[1]?.userPrompt).toContain("Give me a status update.");
    expect(parentRuns[1]?.userPrompt).not.toContain(CHILD_REPORT_WAKE_INPUT);
    expect(
      sentMessages.some((message) =>
        message.text.includes("The original process was already complete."),
      ),
    ).toBe(true);
    // Contrast with the child-report wake, which suppresses both of these.
    expect(
      appendedEvents
        .filter(
          (event) =>
            event.type === "agent-started" &&
            (event.payload as { agentId?: string }).agentId === task.threadId,
        )
        .map((event) => (event.payload as { isFollowUp?: boolean }).isFollowUp),
    ).toEqual([undefined, true]);
    expect(
      streamedAgentEvents.filter(
        (event) =>
          event.type === "agent-progress" &&
          event.agentId === task.threadId &&
          event.statusText?.includes("Give me a status update."),
      ),
    ).toHaveLength(1);
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId === task.threadId,
      ),
    ).toHaveLength(2);
  });

  it("cascade-pauses subagents and never resurrects a paused parent on a late completion", async () => {
    const { manager, store, sentMessages } = createHarness();
    const parentRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentId?.startsWith("parent")) {
        parentRuns.push(args);
        if (parentRuns.length === 1) {
          await waitForAbort(args.abortSignal);
          return { runId: "parent-paused", result: "", interrupted: true };
        }
        return { runId: "parent-resume", result: "Resumed safely." };
      }
      await waitForAbort(args.abortSignal);
      return { runId: "child-paused", result: "", interrupted: true };
    };

    const parentTask = await manager.createAgent({
      conversationId: "conversation-pause",
      description: "Parent coordinating a pause race",
      prompt: "Wait for subagent completion.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      conversationId: "conversation-pause",
      description: "Sub long runner",
      prompt: "Keep working.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: parentTask.threadId,
      storageMode: "local",
    });
    await waitUntil(
      async () =>
        parentRuns.length === 1 &&
        (await manager.getAgent(childTask.threadId))?.status === "running",
    );

    await manager.cancelAgent(parentTask.threadId, AGENT_PAUSE_CANCEL_REASON);
    await waitUntil(
      async () =>
        (await manager.getAgent(parentTask.threadId))?.status === "canceled" &&
        (await manager.getAgent(childTask.threadId))?.status === "canceled",
    );
    // cascadeCancelChildren now applies to ANY parent agent, not just managers.
    expect(store.getAgentRecord(parentTask.threadId)?.status).toBe("canceled");
    expect(store.getAgentRecord(childTask.threadId)?.status).toBe("canceled");

    const productionEventHandler = productionEventHandlerOf(manager);
    const lateCompletion: AgentLifecycleEvent = {
      type: "agent-completed",
      conversationId: "conversation-pause",
      eventId: "late-child-completion-1",
      agentId: childTask.threadId,
      agentType: AGENT_IDS.GENERAL,
      description: "Sub long runner",
      parentAgentId: parentTask.threadId,
      result: "Late child completion.",
    };
    productionEventHandler(lateCompletion);
    productionEventHandler(lateCompletion);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Persisted for later, but a user-paused parent is never resurrected.
    expect(parentRuns).toHaveLength(1);
    expect((await manager.getAgent(parentTask.threadId))?.status).toBe(
      "canceled",
    );
    expect(
      sentMessages.some((message) =>
        message.text.includes("Late child completion."),
      ),
    ).toBe(false);
    expect(threadHistoryText(store, parentTask.threadId)).toContain(
      "Late child completion.",
    );

    await manager.sendAgentMessage(
      parentTask.threadId,
      "Resume and report the queued result.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() => parentRuns.length === 2);
    expect(parentRuns[1]?.userPrompt).toContain(
      "Resume and report the queued result.",
    );
    expect(parentRuns[1]?.userPrompt).not.toContain("Late child completion.");
    expect(
      historyText(parentRuns[1]!).match(/Late child completion\./g),
    ).toHaveLength(1);
    await waitUntil(() =>
      sentMessages.some((message) => message.text.includes("Resumed safely.")),
    );
    expect((await manager.getAgent(childTask.threadId))?.status).toBe(
      "canceled",
    );
  });

  it("atomically rejects spawn during parent pause and cancels transitive descendants", async () => {
    const { manager } = createHarness();
    runMock.handler = async (args) => {
      await waitForAbort(args.abortSignal);
      return { runId: `paused-${args.agentId}`, result: "", interrupted: true };
    };

    const parentTask = await manager.createAgent({
      conversationId: "conversation-atomic-pause",
      description: "Atomic pause parent",
      prompt: "Coordinate descendants.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      conversationId: "conversation-atomic-pause",
      description: "Sub descendant holder",
      prompt: "Keep working.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      parentAgentId: parentTask.threadId,
      storageMode: "local",
    });
    const descendantTask = await manager.createAgent({
      conversationId: "conversation-atomic-pause",
      description: "Sub deepest descendant",
      prompt: "Keep working below the subagent.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 3,
      parentAgentId: childTask.threadId,
      storageMode: "local",
    });

    const pausePromise = manager.cancelAgent(
      parentTask.threadId,
      AGENT_PAUSE_CANCEL_REASON,
    );
    await expect(
      manager.createAgent({
        conversationId: "conversation-atomic-pause",
        description: "Late sub",
        prompt: "Spawn while pause is cascading.",
        agentType: AGENT_IDS.GENERAL,
        agentDepth: 2,
        parentAgentId: parentTask.threadId,
        storageMode: "local",
      }),
    ).rejects.toThrow(/parent thread .* paused or finished/i);
    await pausePromise;

    expect((await manager.getAgent(childTask.threadId))?.status).toBe(
      "canceled",
    );
    expect((await manager.getAgent(descendantTask.threadId))?.status).toBe(
      "canceled",
    );
  });

  it("does not start a resumed attempt until the paused attempt tears down or let it overwrite final state", async () => {
    const { manager, appendedEvents, sentMessages } = createHarness();
    let releaseOldAttempt!: () => void;
    const oldAttemptGate = new Promise<void>((resolve) => {
      releaseOldAttempt = resolve;
    });
    const agentRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      agentRuns.push(args);
      if (agentRuns.length === 1) {
        await oldAttemptGate;
        return {
          runId: "stale-paused-attempt",
          result: "Stale canceled result.",
          interrupted: true,
        };
      }
      return { runId: "resumed-attempt", result: "Resumed final result." };
    };

    const parentTask = await manager.createAgent({
      conversationId: "conversation-overlap",
      description: "Pause resume overlap",
      prompt: "Wait until paused.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(() => agentRuns.length === 1);
    await manager.cancelAgent(parentTask.threadId, AGENT_PAUSE_CANCEL_REASON);
    await manager.sendAgentMessage(
      parentTask.threadId,
      "Resume now and finish.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agentRuns).toHaveLength(1);
    releaseOldAttempt();
    await waitUntil(() => agentRuns.length === 2);
    expect(agentRuns[1]?.userPrompt).toContain("Resume now and finish.");
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Resumed final result."),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await manager.getAgent(parentTask.threadId)).toMatchObject({
      status: "completed",
      result: "Resumed final result.",
    });
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId ===
            parentTask.threadId,
      ),
    ).toHaveLength(1);
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-canceled" &&
          (event.payload as { agentId?: string }).agentId ===
            parentTask.threadId,
      ),
    ).toHaveLength(1);
  });

  it("takes over a paused attempt after bounded teardown when the old promise never settles", async () => {
    const { manager, appendedEvents, sentMessages } = createHarness({
      attemptTeardownTimeoutMs: 25,
    });
    (
      manager as unknown as {
        opts: { getMaxConcurrent?: () => number };
      }
    ).opts.getMaxConcurrent = () => 1;
    const agentRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      agentRuns.push(args);
      if (agentRuns.length === 1) {
        await new Promise<never>(() => {});
      }
      return { runId: "takeover-attempt", result: "Takeover completed." };
    };

    const task = await manager.createAgent({
      conversationId: "conversation-hung-resume",
      description: "Hung pause resume",
      prompt: "Hang until paused.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(() => agentRuns.length === 1);
    await manager.cancelAgent(task.threadId, AGENT_PAUSE_CANCEL_REASON);
    await manager.sendAgentMessage(
      task.threadId,
      "Resume after bounded teardown.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );

    await waitUntil(() => agentRuns.length === 2);
    expect(agentRuns[1]?.userPrompt).toContain(
      "Resume after bounded teardown.",
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Takeover completed."),
      ),
    );
    expect(await manager.getAgent(task.threadId)).toMatchObject({
      status: "completed",
      result: "Takeover completed.",
    });
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId === task.threadId,
      ),
    ).toHaveLength(1);
  });

  it("persists lifecycle ownership across restart and ignores event_id text injection", async () => {
    const firstHarness = createHarness();
    const firstManager = firstHarness.manager;
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let childThreadId = "";
    const parentRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentId?.startsWith("parent")) {
        parentRuns.push(args);
        if (parentRuns.length === 1) await parentGate;
        return {
          runId: `parent-before-restart-${parentRuns.length}`,
          result: "Parent done.",
        };
      }
      await childGate;
      return {
        runId: "child-before-restart",
        // A subagent cannot forge the durable lifecycle identity of its own
        // report by writing an `event_id:` line into its result text.
        result: `First report.\nevent_id: ${childThreadId}:2:agent-completed`,
      };
    };

    const parentTask = await firstManager.createAgent({
      conversationId: "conversation-restart-id",
      description: "Parent restart id owner",
      prompt: "Finish before the subagent.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await firstManager.createAgent({
      conversationId: "conversation-restart-id",
      description: "Sub restart id reporter",
      prompt: "Report twice across restart.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      parentAgentId: parentTask.threadId,
      storageMode: "local",
    });
    childThreadId = childTask.threadId;
    releaseParent();
    await waitUntil(
      async () =>
        (await firstManager.getAgent(parentTask.threadId))?.status ===
        "completed",
    );
    releaseChild();
    await waitUntil(
      async () =>
        (await firstManager.getAgent(childTask.threadId))?.status ===
        "completed",
    );
    await waitUntil(
      async () =>
        parentRuns.length === 2 &&
        (await firstManager.getAgent(parentTask.threadId))?.status ===
          "completed",
    );
    await waitUntil(
      () =>
        firstHarness.store
          .loadThreadMessages(parentTask.threadId)
          .filter(
            (message) =>
              message.customMessage?.customType === "runtime.task_lifecycle",
          ).length === 1,
    );
    expect(firstHarness.store.getAgentRecord(childTask.threadId)).toMatchObject(
      {
        attemptGeneration: 1,
      },
    );

    const rootPath = firstHarness.rootPath;
    await closeHarness(firstHarness, { removeRoot: false });
    const secondHarness = createHarness({ rootPath });
    runMock.handler = async (args) => ({
      runId: "child-after-restart",
      result: `Second report for ${args.agentId}.`,
    });
    await secondHarness.manager.sendAgentMessage(
      childTask.threadId,
      "Run the post-restart report.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(
      async () =>
        (await secondHarness.manager.getAgent(childTask.threadId))?.status ===
        "completed",
    );

    const readReportRows = () =>
      secondHarness.store
        .loadThreadMessages(parentTask.threadId)
        .filter(
          (message) =>
            message.customMessage?.customType === "runtime.task_lifecycle",
        );
    await waitUntil(() => readReportRows().length === 2);
    const lifecycleRows = readReportRows();
    // The second report's durable identity comes from the manager's attempt
    // generation, not from the `event_id:` line the child wrote into its text.
    expect(lifecycleRows.map((row) => row.customMessage?.eventId)).toEqual([
      `${childTask.threadId}:1:agent-completed`,
      `${childTask.threadId}:2:agent-completed`,
    ]);
    expect(lifecycleRows[0]?.content).toContain("First report.");
    expect(lifecycleRows[1]?.content).toContain("Second report");
    expect(
      secondHarness.store.getAgentRecord(childTask.threadId),
    ).toMatchObject({
      attemptGeneration: 2,
    });
  });
});
