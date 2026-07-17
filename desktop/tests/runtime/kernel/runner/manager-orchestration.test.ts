import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import {
  AGENT_PAUSE_CANCEL_REASON,
  type AgentLifecycleEvent,
  type LocalAgentManager,
} from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import { createAgentOrchestration } from "../../../../../runtime/kernel/runner/agent-orchestration.js";
import {
  handleSendInput,
  handleSpawnManager,
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

type MockRunArgs = {
  agentId?: string;
  agentType: string;
  userPrompt: string;
  abortSignal?: AbortSignal;
  agentContext?: {
    threadHistory?: Array<{ content: string }>;
  };
  toolExecutor?: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<unknown>;
};

const runMock = vi.hoisted(() => ({
  handler: null as
    | null
    | ((args: MockRunArgs) => Promise<{
        runId: string;
        result: string;
        interrupted?: boolean;
      }>),
}));

vi.mock("../../../../../runtime/kernel/agent-runtime.js", () => ({
  runSubagentTask: (args: MockRunArgs) => {
    if (!runMock.handler) throw new Error("Missing manager test run handler");
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for manager orchestration state");
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

const reportManager = async (
  args: MockRunArgs,
  kind: "status" | "milestone" | "complete",
): Promise<void> => {
  if (!args.toolExecutor) throw new Error("Missing Manager tool executor");
  await args.toolExecutor("manager_report", { kind }, {} as ToolContext);
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

const createHarness = (options?: {
  rootPath?: string;
  attemptTeardownTimeoutMs?: number;
}): Harness => {
  const rootPath =
    options?.rootPath ??
    path.join(
      os.tmpdir(),
      `stella-manager-orchestration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    deviceId: "device-manager-test",
    runtimeStore: store,
    appendLocalChatEvent: (event: LocalChatAppendEventArgs) => {
      appendedEvents.push(event);
      store.appendEvent(event);
    },
    notifyThreadActivityUpdated: vi.fn(),
    state: {
      localAgentManager: null,
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
        // Mirrors buildAgentContext's real non-orchestrator history hydration.
        // Keeping this wired to SessionStore is what exposes replay duplicates.
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

describe("manager orchestration production routing", () => {
  it("starts spawn_manager with the spawning Orchestrator model snapshot in a customized existing home", async () => {
    let harness = createHarness();
    await mkdir(path.join(harness.rootPath, "agents"), { recursive: true });
    const customizedPrompt = "My customized orchestrator prompt stays intact.";
    await writeFile(
      path.join(harness.rootPath, "agents", "orchestrator.md"),
      customizedPrompt,
      "utf8",
    );
    runMock.handler = async (args) => {
      expect(args.agentType).toBe(AGENT_IDS.MANAGER);
      return {
        runId: "manager-first-turn",
        result: "Consolidated first-turn report.",
      };
    };
    const snapshot: AgentModelConfigSnapshot = {
      engine: "default",
      routeModel: "stella/openai/gpt-5.6-sol",
      reasoningEffort: "high",
    };

    const result = await handleSpawnManager(
      {
        stateRoot: harness.rootPath,
        tasks: new Map(),
        agentApi: harness.manager,
      },
      { prompt: "Coordinate one verification and report." },
      {
        conversationId: "conversation-model-inheritance",
        deviceId: "device-manager-test",
        requestId: "spawn-manager-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
        storageMode: "local",
        modelConfigSnapshot: snapshot,
      },
    );

    const threadId = (result.result as { thread_id: string }).thread_id;
    await waitUntil(
      async () =>
        (await harness.manager.getAgent(threadId))?.status === "completed",
    );
    expect(harness.fetchedModelConfigs).toContainEqual(snapshot);
    expect(harness.store.getAgentRecord(threadId)?.modelConfigSnapshot).toEqual(
      snapshot,
    );
    expect(
      await readFile(
        path.join(harness.rootPath, "agents", "orchestrator.md"),
        "utf8",
      ),
    ).toBe(customizedPrompt);

    // Simulate a Manager row created by the pre-snapshot build. Its first
    // explicit send_input after update inherits the current Orchestrator
    // route, then persists it for every later resume.
    harness.db
      .prepare(
        "UPDATE runtime_agents SET model_config_json = NULL WHERE thread_id = ?",
      )
      .run(threadId);
    await closeHarness(harness, { removeRoot: false });
    harness = createHarness({ rootPath: harness.rootPath });
    runMock.handler = async (_args) => ({
      runId: "manager-resumed-turn",
      result: "Resumed on the inherited route.",
    });
    await handleSendInput(
      {
        stateRoot: harness.rootPath,
        tasks: new Map(),
        agentApi: harness.manager,
      },
      {
        thread_id: threadId,
        description: "Resume manager",
        message: "Resume and confirm the final state.",
      },
      {
        conversationId: "conversation-model-inheritance",
        deviceId: "device-manager-test",
        requestId: "resume-manager-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
        storageMode: "local",
        modelConfigSnapshot: snapshot,
      },
    );
    await waitUntil(() =>
      harness.sentMessages.some((message) =>
        message.text.includes("Resumed on the inherited route."),
      ),
    );
    expect((await harness.manager.getAgent(threadId))?.status).toBe("running");
    expect(harness.fetchedModelConfigs).toContainEqual(snapshot);
    expect(harness.store.getAgentRecord(threadId)?.modelConfigSnapshot).toEqual(
      snapshot,
    );
  });

  it("routes child completion exclusively to the manager and keeps a status answer non-terminal", async () => {
    const { manager, store, appendedEvents, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const managerPrompts: string[] = [];
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerRuns.push(args);
        managerPrompts.push(args.userPrompt);
        if (managerPrompts.length === 1) {
          await managerFirstGate;
          return { runId: "manager-1", result: "Waiting for child." };
        }
        if (managerPrompts.length === 2) {
          await reportManager(args, "status");
          return {
            runId: "manager-2",
            result: "Child still running.",
          };
        }
        if (managerPrompts.length === 3) {
          return {
            runId: "manager-3",
            result: "Steering acknowledged; child still running.",
          };
        }
        await reportManager(args, "complete");
        return { runId: "manager-4", result: "Final consolidated report." };
      }
      await childGate;
      return { runId: "child-1", result: "Child finished cleanly." };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-status",
      description: "Coordinate status test",
      prompt: "Coordinate and report once.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      conversationId: "conversation-status",
      description: "Run child verification",
      prompt: "Verify the claim.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManagerFirst();
    await waitUntil(() => managerPrompts.length === 1);
    await manager.sendAgentMessage(
      managerTask.threadId,
      "Give me a status update, then continue.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) => message.text.includes("[Agent update]")),
    );

    const interim = sentMessages.find((message) =>
      message.text.includes("[Agent update]"),
    );
    expect(interim).toMatchObject({
      customType: "runtime.task_update",
      responseTarget: {
        type: "agent_turn",
        agentId: managerTask.threadId,
      },
    });
    expect(interim?.text).toContain("Child still running.");
    expect(interim?.text).not.toContain("[Status]");
    expect(managerPrompts[1]).toContain("Give me a status update");
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(store.getAgentRecord(managerTask.threadId)?.status).toBe("running");
    expect(appendedEvents.some((event) => event.type === "agent-message")).toBe(
      false,
    );
    expect(
      store
        .listActivity("conversation-status")
        .activities.some((activity) => activity.type === "agent-message"),
    ).toBe(false);
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toBe(false);
    expect(
      sentMessages.some((message) =>
        message.text.includes("Child finished cleanly."),
      ),
    ).toBe(false);

    await manager.sendAgentMessage(
      managerTask.threadId,
      "Prioritize the child's verification, then finish normally.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Steering acknowledged; child still running."),
      ),
    );
    expect(managerPrompts[2]).toContain("If it changes instructions");
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toBe(false);

    releaseChild();
    await waitUntil(async () =>
      ["completed", "error", "canceled"].includes(
        (await manager.getAgent(managerTask.threadId))?.status ?? "",
      ),
    );
    expect(managerPrompts[3]).toContain("newly persisted managed-child event");
    expect(historyText(managerRuns[3]!)).toContain("Child finished cleanly.");
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            childTask.threadId,
      ),
    ).toBe(false);
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(1);
    expect(managerRuns).toHaveLength(4);
  });

  it("keeps managed-child starts, follow-ups, and terminal reminders out of the root transcript", async () => {
    const {
      manager,
      store,
      appendedEvents,
      sentMessages,
      streamedAgentEvents,
    } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
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
    const managerRuns: MockRunArgs[] = [];
    const childRunCounts = new Map<string, number>();

    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerRuns.push(args);
        if (managerRuns.length === 1) {
          await managerFirstGate;
          return {
            runId: "manager-wait",
            result: "Waiting for both children.",
          };
        }
        if (managerRuns.length === 2) {
          await reportManager(args, "milestone");
          return {
            runId: "manager-first-child",
            result: "First child reported; requesting a recheck.",
          };
        }
        if (managerRuns.length === 3) {
          await reportManager(args, "status");
          return {
            runId: "manager-first-child-recheck",
            result: "Recheck received; second child is still running.",
          };
        }
        await reportManager(args, "complete");
        return {
          runId: "manager-final",
          result: "Consolidated manager response after both children.",
        };
      }

      const agentId = args.agentId ?? "missing-child";
      const runCount = (childRunCounts.get(agentId) ?? 0) + 1;
      childRunCounts.set(agentId, runCount);
      if (agentId.includes("first-child")) {
        if (runCount === 1) {
          await firstChildGate;
          return {
            runId: "first-child",
            result: "First child private result.",
          };
        }
        await firstChildFollowUpGate;
        return {
          runId: "first-child-follow-up",
          result: "First child private follow-up result.",
        };
      }
      if (agentId.includes("second-child")) {
        await secondChildGate;
        return {
          runId: "second-child",
          result: "Second child private result.",
        };
      }
      return { runId: "standalone", result: "Standalone direct result." };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-root-filter",
      description: "Coordinate two private children",
      prompt: "Coordinate both children and return one consolidated response.",
      agentType: AGENT_IDS.MANAGER,
      rootRunId: "root-filter-run",
      agentDepth: 1,
      storageMode: "local",
    });
    const firstChild = await manager.createAgent({
      conversationId: "conversation-root-filter",
      description: "First child verification",
      prompt: "Run the first verification.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    const secondChild = await manager.createAgent({
      conversationId: "conversation-root-filter",
      description: "Second child verification",
      prompt: "Run the second verification.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });

    releaseManagerFirst();
    releaseFirstChild();
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("First child reported; requesting a recheck."),
      ),
    );

    await handleSendInput(
      {
        stateRoot: "/tmp",
        tasks: new Map(),
        agentApi: manager,
      },
      {
        thread_id: firstChild.threadId,
        description: "Recheck first child",
        message: "Recheck the first result before consolidation.",
      },
      {
        conversationId: "conversation-root-filter",
        deviceId: "device-manager-test",
        requestId: "manager-child-follow-up",
        agentType: AGENT_IDS.MANAGER,
        agentId: managerTask.threadId,
        storageMode: "local",
      },
    );
    releaseFirstChildFollowUp();
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes(
          "Recheck received; second child is still running.",
        ),
      ),
    );
    releaseSecondChild();
    await waitUntil(
      async () =>
        (await manager.getAgent(managerTask.threadId))?.status === "completed",
    );

    const rootLifecycle = appendedEvents.filter((event) =>
      [
        "agent-started",
        "agent-completed",
        "agent-failed",
        "agent-canceled",
      ].includes(event.type),
    );
    expect(rootLifecycle).toEqual([
      expect.objectContaining({
        type: "agent-started",
        payload: expect.objectContaining({
          agentId: managerTask.threadId,
          attemptGeneration: expect.any(Number),
        }),
      }),
      expect.objectContaining({
        type: "agent-completed",
        payload: expect.objectContaining({
          agentId: managerTask.threadId,
          attemptGeneration: expect.any(Number),
          result: "Consolidated manager response after both children.",
        }),
      }),
    ]);
    expect(
      (rootLifecycle[1]?.payload as { attemptGeneration?: number })
        .attemptGeneration,
    ).toBeGreaterThanOrEqual(
      (rootLifecycle[0]?.payload as { attemptGeneration?: number })
        .attemptGeneration ?? 0,
    );
    expect(JSON.stringify(appendedEvents)).not.toContain("A managed child");
    expect(JSON.stringify(appendedEvents)).not.toContain(firstChild.threadId);
    expect(JSON.stringify(appendedEvents)).not.toContain(secondChild.threadId);
    expect(
      streamedAgentEvents.filter(
        (event) =>
          event.type === "agent-started" &&
          event.agentId === managerTask.threadId,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(streamedAgentEvents)).not.toContain(
      "A managed child",
    );
    expect(
      sentMessages.some((message) =>
        message.text.includes("First child private result."),
      ),
    ).toBe(false);
    expect(
      sentMessages.some((message) =>
        message.text.includes("Second child private result."),
      ),
    ).toBe(false);

    const managerHistory = store
      .loadThreadMessages(managerTask.threadId)
      .map((message) => message.content)
      .join("\n");
    expect(managerHistory).toContain("First child private result.");
    expect(managerHistory).toContain("First child private follow-up result.");
    expect(managerHistory).toContain("Second child private result.");
    const activityIds = store
      .listThreadActivity("conversation-root-filter")
      .map((record) => record.threadId);
    expect(activityIds).toEqual(
      expect.arrayContaining([
        managerTask.threadId,
        firstChild.threadId,
        secondChild.threadId,
      ]),
    );

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

  it("routes a managed grandchild through durable ancestry without root projection", async () => {
    const { manager, store, appendedEvents, sentMessages } = createHarness();
    let releaseManager!: () => void;
    const managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });
    let releaseDescendant!: () => void;
    const descendantGate = new Promise<void>((resolve) => {
      releaseDescendant = resolve;
    });
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerRuns.push(args);
        if (managerRuns.length === 1) await managerGate;
        return {
          runId: `manager-transitive-${managerRuns.length}`,
          result: "Internal descendant coordination only.",
        };
      }
      if (args.agentId?.includes("grandchild")) {
        await descendantGate;
        return {
          runId: "managed-grandchild",
          result: "Grandchild private terminal report.",
        };
      }
      await waitForAbort(args.abortSignal);
      return { runId: "managed-child", result: "", interrupted: true };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-transitive-routing",
      description: "Transitive manager",
      prompt: "Coordinate nested work.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      maxAgentDepth: 3,
      storageMode: "local",
    });
    const child = await manager.createAgent({
      conversationId: "conversation-transitive-routing",
      description: "Managed child",
      prompt: "Own nested work.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 3,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    const grandchild = await manager.createAgent({
      conversationId: "conversation-transitive-routing",
      description: "Managed grandchild",
      prompt: "Return a private report.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 3,
      maxAgentDepth: 3,
      parentAgentId: child.threadId,
      storageMode: "local",
    });

    expect(
      manager.resolveOwningManagerThread(grandchild.threadId, child.threadId),
    ).toBe(managerTask.threadId);
    releaseManager();
    await waitUntil(
      () =>
        managerRuns.length === 1 &&
        !hasInFlightAttempt(manager, managerTask.threadId),
    );
    releaseDescendant();
    await waitUntil(
      () =>
        managerRuns.length === 2 &&
        !hasInFlightAttempt(manager, managerTask.threadId),
    );

    expect(JSON.stringify(appendedEvents)).not.toContain(grandchild.threadId);
    expect(JSON.stringify(sentMessages)).not.toContain(
      "Grandchild private terminal report.",
    );
    expect(
      store
        .loadThreadMessages(managerTask.threadId)
        .map((message) => message.content)
        .join("\n"),
    ).toContain("Grandchild private terminal report.");
    expect(
      store
        .listThreadActivity("conversation-transitive-routing")
        .map((record) => record.threadId),
    ).toEqual(
      expect.arrayContaining([
        managerTask.threadId,
        child.threadId,
        grandchild.threadId,
      ]),
    );
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );

    const rootEventCount = appendedEvents.length;
    const rootMessageCount = sentMessages.length;
    const productionEventHandler = (
      manager as unknown as {
        opts: { onAgentEvent?: (event: AgentLifecycleEvent) => void };
      }
    ).opts.onAgentEvent!;
    productionEventHandler({
      type: "agent-completed",
      conversationId: "conversation-transitive-routing",
      eventId: "legacy-missing-parent-completion",
      agentId: "legacy-missing-child",
      agentType: AGENT_IDS.GENERAL,
      description: "Legacy missing child",
      parentAgentId: "missing-parent-link",
      result: "Must not escape to root.",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(appendedEvents).toHaveLength(rootEventCount);
    expect(sentMessages).toHaveLength(rootMessageCount);
    expect(
      manager.resolveOwningManagerThread(
        "legacy-missing-child",
        "missing-parent-link",
      ),
    ).toBeNull();

    const taskRecords = (
      manager as unknown as {
        tasks: Map<string, { parentAgentId?: string }>;
      }
    ).tasks;
    taskRecords.get(child.threadId)!.parentAgentId = grandchild.threadId;
    taskRecords.get(grandchild.threadId)!.parentAgentId = child.threadId;
    expect(
      manager.resolveOwningManagerThread(grandchild.threadId, child.threadId),
    ).toBeNull();
    await manager.cancelAgent(managerTask.threadId, AGENT_PAUSE_CANCEL_REASON);
  });

  it.each([
    "Status?",
    "Any update?",
    "Give me an update.",
    "What’s the current status?",
    "How’s the work going?",
    "Are you done yet?",
    "How far along are you?",
  ])(
    "keeps a natural-language status poke before the first child non-terminal: %s",
    async (statusRequest) => {
      const { manager, store, appendedEvents, sentMessages } = createHarness();
      const managerRuns: MockRunArgs[] = [];
      runMock.handler = async (args) => {
        managerRuns.push(args);
        if (managerRuns.length === 1) {
          await waitForAbort(args.abortSignal);
          return {
            runId: "planning-interrupted",
            result: "",
            interrupted: true,
          };
        }
        if (managerRuns.length === 2) {
          await reportManager(args, "status");
          return {
            runId: "planning-status",
            result: "planning is underway; no child has started yet.",
          };
        }
        return {
          runId: "planning-final",
          result: "Planning resumed and the process finished.",
        };
      };

      const task = await manager.createAgent({
        conversationId: "conversation-planning-status",
        description: "Plan managed work",
        prompt: "Plan the process before spawning the first child.",
        agentType: AGENT_IDS.MANAGER,
        agentDepth: 1,
        storageMode: "local",
      });
      await waitUntil(() => managerRuns.length === 1);
      await manager.sendAgentMessage(
        task.threadId,
        statusRequest,
        "orchestrator",
        { deliveryKind: "external-input" },
      );
      await waitUntil(() =>
        sentMessages.some((message) =>
          message.text.includes("planning is underway; no child has started"),
        ),
      );

      expect(managerRuns[1]?.userPrompt).toContain(statusRequest);
      expect(managerRuns[1]?.userPrompt).toContain(statusRequest);
      expect((await manager.getAgent(task.threadId))?.status).toBe("running");
      expect(store.getAgentRecord(task.threadId)?.status).toBe("running");
      expect(
        appendedEvents.filter(
          (event) =>
            event.type === "agent-completed" &&
            (event.payload as { agentId?: string })?.agentId === task.threadId,
        ),
      ).toHaveLength(0);

      await manager.sendAgentMessage(
        task.threadId,
        "Continue the planned process and finish it.",
        "orchestrator",
        { deliveryKind: "external-input" },
      );
      await waitUntil(() =>
        sentMessages.some((message) =>
          message.text.includes("Planning resumed and the process finished."),
        ),
      );
      expect((await manager.getAgent(task.threadId))?.status).toBe("running");
      expect(managerRuns).toHaveLength(3);
      expect(managerRuns[2]?.userPrompt).toContain(
        "Continue the planned process and finish it.",
      );
      expect(managerRuns[2]?.userPrompt).toContain(
        "If it changes instructions",
      );
      expect(
        appendedEvents.filter(
          (event) =>
            event.type === "agent-completed" &&
            (event.payload as { agentId?: string })?.agentId === task.threadId,
        ),
      ).toHaveLength(0);
    },
  );

  it("keeps rapid repeated status-sentinel turns non-terminal", async () => {
    const { manager, appendedEvents, sentMessages } = createHarness();
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      managerRuns.push(args);
      if (managerRuns.length <= 2) {
        await waitForAbort(args.abortSignal);
        return {
          runId: `rapid-status-interrupted-${managerRuns.length}`,
          result: "",
          interrupted: true,
        };
      }
      if (managerRuns.length === 3) {
        await reportManager(args, "status");
        return {
          runId: "rapid-status-reply",
          result: "Still planning; no child has started.",
        };
      }
      return {
        runId: "rapid-status-final",
        result: "Planning finished after the status checks.",
      };
    };

    const task = await manager.createAgent({
      conversationId: "conversation-rapid-status",
      description: "Plan through rapid status checks",
      prompt: "Plan the process, then finish it.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(() => managerRuns.length === 1);
    await manager.sendAgentMessage(
      task.threadId,
      "Any update?",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() => managerRuns.length === 2);
    await manager.sendAgentMessage(
      task.threadId,
      "How far along are you?",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Still planning; no child has started."),
      ),
    );

    expect(managerRuns).toHaveLength(3);
    expect(managerRuns[1]?.userPrompt).toContain("Any update?");
    expect(managerRuns[2]?.userPrompt).toContain("How far along are you?");
    expect(
      sentMessages.some((message) => message.text.includes("[Status]")),
    ).toBe(false);
    expect((await manager.getAgent(task.threadId))?.status).toBe("running");
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId === task.threadId,
      ),
    ).toBe(false);

    await manager.sendAgentMessage(
      task.threadId,
      "Continue the process and finish.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Planning finished after the status checks."),
      ),
    );
    expect((await manager.getAgent(task.threadId))?.status).toBe("running");
    expect(managerRuns).toHaveLength(4);
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId === task.threadId,
      ),
    ).toHaveLength(0);
  });

  it("keeps a between-stage status poke non-terminal with no active child", async () => {
    const { manager, store, appendedEvents, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    let releaseStageOne!: () => void;
    const stageOneGate = new Promise<void>((resolve) => {
      releaseStageOne = resolve;
    });
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentType !== AGENT_IDS.MANAGER) {
        await stageOneGate;
        return { runId: "stage-one", result: "Stage one finished." };
      }
      managerRuns.push(args);
      if (managerRuns.length === 1) {
        await managerFirstGate;
        return {
          runId: "between-stage-wait",
          result: "Waiting for stage one.",
        };
      }
      if (managerRuns.length === 2) {
        await waitForAbort(args.abortSignal);
        return {
          runId: "between-stage-interrupted",
          result: "",
          interrupted: true,
        };
      }
      if (managerRuns.length === 3) {
        await reportManager(args, "status");
        return {
          runId: "between-stage-status",
          result: "stage one finished; stage two has not started.",
        };
      }
      return {
        runId: "between-stage-final",
        result: "Stage two completed and the process settled.",
      };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-between-stage",
      description: "Coordinate two stages",
      prompt: "Run stage one, then stage two, then report.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await manager.createAgent({
      conversationId: "conversation-between-stage",
      description: "Run stage one",
      prompt: "Complete stage one.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManagerFirst();
    await waitUntil(
      () =>
        managerRuns.length === 1 &&
        !hasInFlightAttempt(manager, managerTask.threadId),
    );
    releaseStageOne();
    await waitUntil(() => managerRuns.length === 2);
    await manager.sendAgentMessage(
      managerTask.threadId,
      "Where do we stand?",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("stage one finished; stage two has not started"),
      ),
    );

    expect(managerRuns[2]?.userPrompt).toContain("Where do we stand?");
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(store.getAgentRecord(managerTask.threadId)?.status).toBe("running");
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(0);

    await manager.sendAgentMessage(
      managerTask.threadId,
      "Continue with stage two and finish.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Stage two completed and the process settled."),
      ),
    );
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(managerRuns).toHaveLength(4);
    expect(managerRuns[3]?.userPrompt).toContain(
      "Continue with stage two and finish.",
    );
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(0);
  });

  it("keeps post-completion status input on the existing terminal follow-up path", async () => {
    const { manager, appendedEvents, sentMessages } = createHarness();
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      managerRuns.push(args);
      if (managerRuns.length === 1) {
        return {
          runId: "terminal-first",
          result: "Original process complete.",
        };
      }
      await reportManager(args, "status");
      return {
        runId: "terminal-status-follow-up",
        result: "The original process was already complete.",
      };
    };

    const task = await manager.createAgent({
      conversationId: "conversation-terminal-status",
      description: "Complete managed work",
      prompt: "Complete the managed work now.",
      agentType: AGENT_IDS.MANAGER,
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
    await waitUntil(() => managerRuns.length === 2);
    await waitUntil(() =>
      sentMessages.some((message) => message.text.includes("already complete")),
    );
    expect((await manager.getAgent(task.threadId))?.status).toBe("running");

    expect(managerRuns[1]?.userPrompt).toContain("Give me a status update.");
    expect(managerRuns[1]?.userPrompt).not.toContain(
      "follow the Manager status-response protocol",
    );
    expect(
      sentMessages.some(
        (message) =>
          message.customType === "runtime.task_update" &&
          message.text.includes("already complete"),
      ),
    ).toBe(true);
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId === task.threadId,
      ),
    ).toHaveLength(1);
  });

  it("publishes an instructed sentinel-prefixed milestone without completing the manager", async () => {
    const { manager, store, appendedEvents, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const managerPrompts: string[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerPrompts.push(args.userPrompt);
        if (managerPrompts.length === 1) {
          await managerFirstGate;
          await reportManager(args, "milestone");
          return {
            runId: "manager-milestone-1",
            result: "Stage one is complete; continuing stage two.",
          };
        }
        await reportManager(args, "complete");
        return {
          runId: "manager-milestone-2",
          result: "Final consolidated stage report.",
        };
      }
      await childGate;
      return { runId: "child-stage-2", result: "Stage two is complete." };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-milestone",
      description: "Coordinate staged reporting",
      prompt: "Run the stages. Report after each stage, then continue.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await manager.createAgent({
      conversationId: "conversation-milestone",
      description: "Run stage two",
      prompt: "Complete stage two.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManagerFirst();

    await waitUntil(() =>
      sentMessages.some(
        (message) =>
          message.customType === "runtime.task_update" &&
          message.text.includes("Stage one is complete"),
      ),
    );
    expect(managerPrompts[0]).toContain(
      "Report after each stage, then continue.",
    );
    expect(
      sentMessages.find((message) =>
        message.text.includes("Stage one is complete"),
      ),
    ).toMatchObject({
      customType: "runtime.task_update",
      responseTarget: {
        type: "agent_turn",
        agentId: managerTask.threadId,
      },
    });
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(store.getAgentRecord(managerTask.threadId)?.status).toBe("running");
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toBe(false);

    releaseChild();
    await waitUntil(async () =>
      ["completed", "error", "canceled"].includes(
        (await manager.getAgent(managerTask.threadId))?.status ?? "",
      ),
    );
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(1);
  });

  it("internalizes unsolicited non-sentinel manager output while children remain active", async () => {
    const { manager, store, appendedEvents, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const managerPrompts: string[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerPrompts.push(args.userPrompt);
        if (managerPrompts.length === 1) {
          await managerFirstGate;
          return {
            runId: "manager-internal-1",
            result: "Stage one is complete; continuing internally.",
          };
        }
        if (managerPrompts.length === 2) {
          return {
            runId: "manager-internal-review",
            result: "Fleet is idle; reviewing before consolidation.",
          };
        }
        await reportManager(args, "complete");
        return {
          runId: "manager-internal-final",
          result: "Final consolidated internal report.",
        };
      }
      await childGate;
      return { runId: "child-internal-2", result: "Remaining work complete." };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-internal",
      description: "Coordinate internal stages",
      prompt: "Coordinate all stages and report only when the work settles.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await manager.createAgent({
      conversationId: "conversation-internal",
      description: "Run remaining work",
      prompt: "Complete the remaining work.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManagerFirst();

    await waitUntil(
      () =>
        managerPrompts.length === 1 &&
        !hasInFlightAttempt(manager, managerTask.threadId),
    );
    expect(
      sentMessages.some((message) =>
        message.text.includes("Stage one is complete; continuing internally."),
      ),
    ).toBe(false);
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(store.getAgentRecord(managerTask.threadId)?.status).toBe("running");
    expect(store.getAgentRecord(managerTask.threadId)?.result).toBeUndefined();
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toBe(false);

    releaseChild();
    await waitUntil(
      () =>
        managerPrompts.length === 2 &&
        !hasInFlightAttempt(manager, managerTask.threadId),
    );
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(JSON.stringify(sentMessages)).not.toContain("Fleet is idle");
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(0);

    await manager.sendAgentMessage(
      managerTask.threadId,
      "Finish the internal consolidation now.",
      managerTask.threadId,
      { deliveryKind: "manager-event" },
    );
    await waitUntil(
      async () =>
        (await manager.getAgent(managerTask.threadId))?.status === "completed",
    );
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(1);
  });

  it("cascade-pauses children and never resurrects a paused manager on a late completion", async () => {
    const { manager, store, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    const managerPrompts: string[] = [];
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerRuns.push(args);
        managerPrompts.push(args.userPrompt);
        if (managerPrompts.length === 1) {
          await managerFirstGate;
          return { runId: "manager-wait", result: "Waiting." };
        }
        if (managerPrompts.length === 2) {
          await reportManager(args, "status");
          return {
            runId: "manager-status-before-pause",
            result: "Waiting for the child before the pause.",
          };
        }
        return { runId: "manager-resume", result: "Resumed safely." };
      }
      await waitForAbort(args.abortSignal);
      return { runId: "child-paused", result: "", interrupted: true };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-pause",
      description: "Coordinate pause race",
      prompt: "Wait for child completion.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      conversationId: "conversation-pause",
      description: "Long child",
      prompt: "Keep working.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManagerFirst();
    await waitUntil(
      () =>
        managerPrompts.length === 1 &&
        !hasInFlightAttempt(manager, managerTask.threadId),
    );
    await manager.sendAgentMessage(
      managerTask.threadId,
      "Any update before I pause this?",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Waiting for the child before the pause."),
      ),
    );
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    await manager.cancelAgent(managerTask.threadId, AGENT_PAUSE_CANCEL_REASON);

    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "canceled",
    );
    expect((await manager.getAgent(childTask.threadId))?.status).toBe(
      "canceled",
    );
    expect(store.getAgentRecord(managerTask.threadId)?.status).toBe("canceled");
    expect(store.getAgentRecord(childTask.threadId)?.status).toBe("canceled");

    const productionEventHandler = (
      manager as unknown as {
        opts: { onAgentEvent?: (event: AgentLifecycleEvent) => void };
      }
    ).opts.onAgentEvent!;
    const lateCompletion: AgentLifecycleEvent = {
      type: "agent-completed",
      conversationId: "conversation-pause",
      eventId: "late-child-completion-1",
      agentId: childTask.threadId,
      agentType: AGENT_IDS.GENERAL,
      description: "Long child",
      parentAgentId: managerTask.threadId,
      result: "Late child completion.",
    };
    productionEventHandler(lateCompletion);
    productionEventHandler(lateCompletion);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(managerPrompts).toHaveLength(2);
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "canceled",
    );
    expect(
      sentMessages.some((message) =>
        message.text.includes("Late child completion."),
      ),
    ).toBe(false);

    await manager.sendAgentMessage(
      managerTask.threadId,
      "Resume and report the queued result.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() => managerPrompts.length === 3);
    expect(managerPrompts[2]).toContain("Resume and report the queued result.");
    expect(managerPrompts[2]).not.toContain("Late child completion.");
    expect(
      historyText(managerRuns[2]!).match(/Late child completion\./g),
    ).toHaveLength(1);
    await waitUntil(() =>
      sentMessages.some((message) => message.text.includes("Resumed safely.")),
    );
    expect((await manager.getAgent(childTask.threadId))?.status).toBe(
      "canceled",
    );
  });

  it("atomically rejects spawn during manager pause and cancels transitive descendants", async () => {
    const { manager } = createHarness();
    runMock.handler = async (args) => {
      await waitForAbort(args.abortSignal);
      return { runId: `paused-${args.agentId}`, result: "", interrupted: true };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-atomic-pause",
      description: "Atomic pause manager",
      prompt: "Coordinate descendants.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      conversationId: "conversation-atomic-pause",
      description: "Legacy child",
      prompt: "Keep working.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    const descendantTask = await manager.createAgent({
      conversationId: "conversation-atomic-pause",
      description: "Legacy descendant",
      prompt: "Keep working below the child.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 3,
      parentAgentId: childTask.threadId,
      storageMode: "local",
    });

    const pausePromise = manager.cancelAgent(
      managerTask.threadId,
      AGENT_PAUSE_CANCEL_REASON,
    );
    await expect(
      manager.createAgent({
        conversationId: "conversation-atomic-pause",
        description: "Late child",
        prompt: "Spawn while pause is cascading.",
        agentType: AGENT_IDS.GENERAL,
        agentDepth: 2,
        parentAgentId: managerTask.threadId,
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
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      managerRuns.push(args);
      if (managerRuns.length === 1) {
        await oldAttemptGate;
        return {
          runId: "stale-paused-attempt",
          result: "Stale canceled result.",
          interrupted: true,
        };
      }
      return { runId: "resumed-attempt", result: "Resumed final result." };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-overlap",
      description: "Pause resume overlap",
      prompt: "Wait until paused.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(() => managerRuns.length === 1);
    await manager.cancelAgent(managerTask.threadId, AGENT_PAUSE_CANCEL_REASON);
    await manager.sendAgentMessage(
      managerTask.threadId,
      "Resume now and finish.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(managerRuns).toHaveLength(1);
    releaseOldAttempt();
    await waitUntil(() => managerRuns.length === 2);
    expect(managerRuns[1]?.userPrompt).toContain("Resume now and finish.");
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Resumed final result."),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await manager.getAgent(managerTask.threadId)).toMatchObject({
      status: "running",
    });
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(0);
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-canceled" &&
          (event.payload as { agentId?: string }).agentId ===
            managerTask.threadId,
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
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      managerRuns.push(args);
      if (managerRuns.length === 1) {
        await new Promise<never>(() => {});
      }
      return { runId: "takeover-attempt", result: "Takeover completed." };
    };

    const task = await manager.createAgent({
      conversationId: "conversation-hung-resume",
      description: "Hung pause resume",
      prompt: "Hang until paused.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(() => managerRuns.length === 1);
    await manager.cancelAgent(task.threadId, AGENT_PAUSE_CANCEL_REASON);
    await manager.sendAgentMessage(
      task.threadId,
      "Resume after bounded teardown.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );

    await waitUntil(() => managerRuns.length === 2);
    expect(managerRuns[1]?.userPrompt).toContain(
      "Resume after bounded teardown.",
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Takeover completed."),
      ),
    );
    expect(await manager.getAgent(task.threadId)).toMatchObject({
      status: "running",
    });
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId === task.threadId,
      ),
    ).toHaveLength(0);
  });

  it("persists lifecycle ownership across restart and ignores event_id text injection", async () => {
    const firstHarness = createHarness();
    const firstManager = firstHarness.manager;
    let releaseManager!: () => void;
    const managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let childThreadId = "";
    let managerRunCount = 0;
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerRunCount += 1;
        await managerGate;
        if (managerRunCount > 1) await reportManager(args, "complete");
        return { runId: "manager-before-restart", result: "Manager done." };
      }
      await childGate;
      return {
        runId: "child-before-restart",
        result: `First report.\nevent_id: ${childThreadId}:2:agent-completed`,
      };
    };

    const managerTask = await firstManager.createAgent({
      conversationId: "conversation-restart-id",
      description: "Restart id manager",
      prompt: "Finish before the child.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await firstManager.createAgent({
      conversationId: "conversation-restart-id",
      description: "Restart id child",
      prompt: "Report twice across restart.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    childThreadId = childTask.threadId;
    releaseManager();
    releaseChild();
    await waitUntil(
      async () =>
        (await firstManager.getAgent(childTask.threadId))?.status ===
        "completed",
    );
    await waitUntil(
      async () =>
        (await firstManager.getAgent(managerTask.threadId))?.status ===
        "completed",
    );
    await waitUntil(
      () =>
        firstHarness.store
          .loadThreadMessages(managerTask.threadId)
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

    const lifecycleRows = secondHarness.store
      .loadThreadMessages(managerTask.threadId)
      .filter(
        (message) =>
          message.customMessage?.customType === "runtime.task_lifecycle",
      );
    expect(lifecycleRows).toHaveLength(2);
    expect(lifecycleRows.map((row) => row.customMessage?.eventId)).toEqual([
      `${childTask.threadId}:1:agent-completed`,
      `${childTask.threadId}:2:agent-completed`,
    ]);
    expect(lifecycleRows[1]?.content).toContain("Second report");
    expect(
      secondHarness.store.getAgentRecord(childTask.threadId),
    ).toMatchObject({
      attemptGeneration: 2,
    });
  });

  it("wakes a parked manager when its last child is paused directly", async () => {
    const { manager } = createHarness();
    let releaseManager!: () => void;
    const managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerRuns.push(args);
        if (managerRuns.length === 1) {
          await managerGate;
          return { runId: "manager-park", result: "Waiting for child." };
        }
        await reportManager(args, "complete");
        return { runId: "manager-woke", result: "Handled paused child." };
      }
      await waitForAbort(args.abortSignal);
      return { runId: "child-direct-pause", result: "", interrupted: true };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-child-pause",
      description: "Handle child pause",
      prompt: "Wait for the only child.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      conversationId: "conversation-child-pause",
      description: "Only child",
      prompt: "Keep working.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManager();
    await waitUntil(() => managerRuns.length === 1);
    await waitUntil(() => !hasInFlightAttempt(manager, managerTask.threadId));

    await manager.cancelAgent(childTask.threadId, AGENT_PAUSE_CANCEL_REASON);
    await waitUntil(() => managerRuns.length === 2);
    expect(managerRuns[1]?.userPrompt).toContain(
      "newly persisted managed-child event",
    );
    expect(historyText(managerRuns[1]!)).toContain("[Managed child paused]");
    expect(historyText(managerRuns[1]!)).toContain(
      "A managed child was paused by the user",
    );
    await waitUntil(
      async () =>
        (await manager.getAgent(managerTask.threadId))?.status === "completed",
    );
  });

  it("enforces exclusive, acyclic, same-conversation adoption and rejects post-completion adoption", async () => {
    const { manager, sentMessages } = createHarness();
    runMock.handler = async (args) => {
      if (args.userPrompt.includes("Finish immediately")) {
        return { runId: "finished", result: "Already delivered." };
      }
      await waitForAbort(args.abortSignal);
      return { runId: "blocked", result: "", interrupted: true };
    };

    const managerA = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Manager A",
      prompt: "Wait.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const managerB = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Manager B",
      prompt: "Wait.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const child = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Adoptable child",
      prompt: "Wait.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const otherConversationChild = await manager.createAgent({
      conversationId: "conversation-other",
      description: "Other conversation child",
      prompt: "Wait.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const cycleChild = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Cycle child",
      prompt: "Wait.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const cycleManager = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Cycle manager",
      prompt: "Wait.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      parentAgentId: cycleChild.threadId,
      storageMode: "local",
    });
    const completed = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Completed before adoption",
      prompt: "Finish immediately.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(completed.threadId))?.status === "completed",
    );

    await expect(
      manager.adoptAgent(managerA.threadId, managerA.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/itself/),
    });
    await expect(
      manager.adoptAgent(managerB.threadId, managerA.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/Managers cannot adopt/),
    });
    await expect(
      manager.adoptAgent(otherConversationChild.threadId, managerA.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/another conversation/),
    });
    await expect(
      manager.adoptAgent(cycleChild.threadId, cycleManager.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/cycle/),
    });
    await expect(
      manager.adoptAgent(child.threadId, managerA.threadId),
    ).resolves.toEqual({ adopted: true });
    await expect(
      manager.adoptAgent(child.threadId, managerB.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/already owned/),
    });
    await expect(
      manager.adoptAgent(completed.threadId, managerA.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/terminal thread/),
    });
    expect(
      sentMessages.filter((message) =>
        message.text.includes("Already delivered."),
      ),
    ).toHaveLength(1);

    await manager.cancelAgent(managerA.threadId, AGENT_PAUSE_CANCEL_REASON);
    await expect(
      manager.adoptAgent(child.threadId, managerB.threadId),
    ).resolves.toEqual({ adopted: true });
  });
});
