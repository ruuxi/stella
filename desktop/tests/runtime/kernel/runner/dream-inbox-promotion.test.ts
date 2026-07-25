import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import type { LocalAgentManager } from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import { createAgentOrchestration } from "../../../../../runtime/kernel/runner/agent-orchestration.js";
import type { RunnerContext } from "../../../../../runtime/kernel/runner/types.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
import type {
  LocalChatAppendEventArgs,
  SqliteDatabase,
} from "../../../../../runtime/kernel/storage/shared.js";
import type { ToolContext } from "../../../../../runtime/kernel/tools/types.js";

// Two-phase Dream-inbox stamping, exercised through the REAL lifecycle
// pipeline (LocalAgentManager executeTask → handleAgentLifecycleEvent):
// a thread_summary row recorded at finalize must stay NULL-conversation —
// mechanically unconsumable — until its terminal report has actually been
// persisted to the stamped conversation's orchestrator thread.

type MockRunArgs = {
  agentId?: string;
  agentType: string;
  userPrompt: string;
  toolExecutor?: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<unknown>;
};

const runMock: {
  handler: ((args: MockRunArgs) => Promise<unknown>) | null;
} = { handler: null };

vi.mock("../../../../../runtime/kernel/agent-runtime.js", () => ({
  runSubagentTask: (args: MockRunArgs) => {
    if (!runMock.handler) throw new Error("Missing promotion test run handler");
    return runMock.handler(args);
  },
  shutdownSubagentRuntimes: vi.fn(),
}));

type Harness = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
  manager: LocalAgentManager;
};

const harnesses = new Set<Harness>();

const waitUntil = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for promotion test state");
};

const createHarness = (): Harness => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-dream-promotion-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const store = new SessionStore(db);
  const context = {
    stellaAppDir: rootPath,
    stellaDataDir: rootPath,
    deviceId: "device-promotion-test",
    runtimeStore: store,
    appendLocalChatEvent: (event: LocalChatAppendEventArgs) => {
      store.appendEvent(event);
    },
    notifyThreadActivityUpdated: vi.fn(),
    state: {
      localAgentManager: null,
      runCallbacksByRunId: new Map(),
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
    buildAgentContext: async ({ threadId }) => ({
      systemPrompt: "",
      dynamicContext: "",
      maxAgentDepth: 2,
      threadHistory: store.loadThreadMessages(threadId),
      resolvedLlm: {
        model: { id: "test-model", provider: "openai" },
      },
    }),
    sendMessage: async () => {},
  });
  const harness = {
    rootPath,
    db,
    store,
    manager: context.state.localAgentManager!,
  };
  harnesses.add(harness);
  return harness;
};

afterEach(async () => {
  runMock.handler = null;
  for (const harness of harnesses) {
    harness.manager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    harness.db.close();
    await rm(harness.rootPath, { recursive: true, force: true });
  }
  harnesses.clear();
  vi.clearAllMocks();
});

const CONVERSATION = "conv-promotion";
const COVERED_KINDS = ["thread_summary", "memory_note"] as const;

/** Simulates the thread-summaries hook's phase-1 record at finalize. */
const recordRow = (
  store: SessionStore,
  threadId: string,
  runId: string,
  rolloutSummary: string,
) =>
  store.dreamInboxStore.recordThreadSummary({
    threadId,
    runId,
    agentType: "general",
    rolloutSummary,
  });

const rowFor = (store: SessionStore, threadId: string, content: string) =>
  store.dreamInboxStore
    .listUnprocessed({ limit: 50 })
    .find((row) => row.threadId === threadId && row.content === content);

const sweepWindow = (store: SessionStore) =>
  store.dreamInboxStore.markKindsProcessedThrough({
    conversationId: CONVERSATION,
    kinds: COVERED_KINDS,
    sinceTs: Date.now() - 60 * 60 * 1_000,
    throughTs: Date.now() + 60 * 60 * 1_000,
  });

describe("dream-inbox two-phase stamp promotion", () => {
  it("stamps a row only after the terminal report persists to the orchestrator thread (crash window stays NULL)", async () => {
    const { manager, store } = createHarness();
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    runMock.handler = async () => {
      await childGate;
      return { runId: "run-1", result: "Verified the deploy pipeline." };
    };

    const task = await manager.createAgent({
      conversationId: CONVERSATION,
      description: "Verify pipeline",
      prompt: "Verify it.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    // Phase 1: the finalize-time record exists while the run is in flight
    // — exactly the crash-window state (row present, no terminal event).
    recordRow(store, task.threadId, "run-1", "Verified the deploy pipeline.");
    const pending = rowFor(
      store,
      task.threadId,
      "Verified the deploy pipeline.",
    );
    expect(pending?.conversationId).toBeNull();
    expect(sweepWindow(store).updated).toBe(0);

    // Completion: the terminal event takes the orchestrator-persist branch
    // and promotes the row in the same synchronous block as the persist.
    releaseChild();
    await waitUntil(
      () =>
        rowFor(store, task.threadId, "Verified the deploy pipeline.")
          ?.conversationId === CONVERSATION,
    );
    expect(sweepWindow(store).updated).toBe(1);
  });

  it("send_input supersession: a success finalize with a queued follow-up never yields a consumable row", async () => {
    const { manager, store } = createHarness();
    const gates: Array<() => void> = [];
    const childCalls: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      childCalls.push(args);
      const attempt = childCalls.length;
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      return attempt === 1
        ? { runId: "attempt-1", result: "First attempt result." }
        : { runId: "attempt-2", result: "Second attempt result." };
    };

    const task = await manager.createAgent({
      conversationId: CONVERSATION,
      description: "Superseded work",
      prompt: "Do the work.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(() => childCalls.length === 1);
    // Attempt 1 finalizes successfully… but a send_input follow-up is
    // already queued, so executeTask takes deliverFollowUpAsNextTurn and no
    // terminal report is ever persisted for attempt 1.
    recordRow(store, task.threadId, "attempt-1", "First attempt result.");
    await manager.sendAgentMessage(
      task.threadId,
      "Actually, change direction.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    gates[0]!();
    await waitUntil(() => childCalls.length === 2);

    // The stamped-row hole from the review: pre-fix, this row carried the
    // root conversation and a later cutover window would have consumed it
    // though its report reached no thread. Now it is NULL and unsweepable.
    const attempt1 = rowFor(store, task.threadId, "First attempt result.");
    expect(attempt1?.conversationId).toBeNull();
    expect(sweepWindow(store).updated).toBe(0);

    // Attempt 2 really finishes: only ITS content gets promoted — the
    // superseded attempt's row stays NULL forever (model-driven path).
    recordRow(store, task.threadId, "attempt-2", "Second attempt result.");
    gates[1]!();
    await waitUntil(
      () =>
        rowFor(store, task.threadId, "Second attempt result.")
          ?.conversationId === CONVERSATION,
    );
    expect(
      rowFor(store, task.threadId, "First attempt result.")?.conversationId,
    ).toBeNull();
    expect(sweepWindow(store).updated).toBe(1);
    expect(
      rowFor(store, task.threadId, "First attempt result.")?.processedByDreamAt,
    ).toBeNull();
  });

  it("parent-owned subagent completions route to the parent thread and never promote", async () => {
    const { manager, store } = createHarness();
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let parentThreadId = "";
    const parentPrompts: string[] = [];
    runMock.handler = async (args) => {
      if (args.agentId === parentThreadId) {
        parentPrompts.push(args.userPrompt);
        if (parentPrompts.length === 1) {
          await parentGate;
          return { runId: "parent-1", result: "Waiting on subagent." };
        }
        return { runId: "parent-2", result: "Acknowledged subagent report." };
      }
      await childGate;
      return { runId: "child-1", result: "Subagent finished." };
    };

    const parentTask = await manager.createAgent({
      conversationId: CONVERSATION,
      description: "Coordinate",
      prompt: "Coordinate.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      maxAgentDepth: 2,
      storageMode: "local",
    });
    parentThreadId = parentTask.threadId;
    const childTask = await manager.createAgent({
      conversationId: CONVERSATION,
      description: "Delegated work",
      prompt: "Work.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: parentTask.threadId,
      storageMode: "local",
    });
    recordRow(store, childTask.threadId, "child-1", "Subagent finished.");
    releaseParent();
    releaseChild();
    // The subagent's terminal report wakes its parent (its second turn) —
    // the orchestrator-persist branch is never taken for it.
    await waitUntil(() => parentPrompts.length >= 2);

    const childRow = rowFor(store, childTask.threadId, "Subagent finished.");
    expect(childRow?.conversationId).toBeNull();
    expect(sweepWindow(store).updated).toBe(0);
  });
});
