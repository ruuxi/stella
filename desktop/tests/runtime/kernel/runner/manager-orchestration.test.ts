import { rm } from "node:fs/promises";
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

type MockRunArgs = {
  agentId?: string;
  agentType: string;
  userPrompt: string;
  abortSignal?: AbortSignal;
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

const createHarness = (): Harness => {
  const rootPath = path.join(
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
    buildAgentContext: async () => ({
      systemPrompt: "",
      dynamicContext: "",
      maxAgentDepth: 2,
      resolvedLlm: {
        model: { id: "test-model", provider: "openai" },
      },
    }),
    sendMessage: async (message) => {
      sentMessages.push(message);
    },
  });
  const harness = {
    rootPath,
    db,
    store,
    manager: context.state.localAgentManager!,
    appendedEvents,
    sentMessages,
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

describe("manager orchestration production routing", () => {
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
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerPrompts.push(args.userPrompt);
        if (managerPrompts.length === 1) {
          await managerFirstGate;
          return { runId: "manager-1", result: "Waiting for child." };
        }
        if (managerPrompts.length === 2) {
          return { runId: "manager-2", result: "Status: child still running." };
        }
        return { runId: "manager-3", result: "Final consolidated report." };
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
    expect(interim?.text).toContain("Status: child still running.");
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

    releaseChild();
    await waitUntil(async () =>
      ["completed", "error", "canceled"].includes(
        (await manager.getAgent(managerTask.threadId))?.status ?? "",
      ),
    );
    expect(managerPrompts[2]).toContain("Child finished cleanly.");
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
  });

  it("cascade-pauses children and never resurrects a paused manager on a late completion", async () => {
    const { manager, store, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    const managerPrompts: string[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerPrompts.push(args.userPrompt);
        if (managerPrompts.length === 1) {
          await managerFirstGate;
          return { runId: "manager-wait", result: "Waiting." };
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
    await waitUntil(() => managerPrompts.length === 1);
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
    productionEventHandler({
      type: "agent-completed",
      conversationId: "conversation-pause",
      agentId: childTask.threadId,
      agentType: AGENT_IDS.GENERAL,
      description: "Long child",
      parentAgentId: managerTask.threadId,
      result: "Late child completion.",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(managerPrompts).toHaveLength(1);
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
    await waitUntil(() => managerPrompts.length === 2);
    expect(managerPrompts[1]).toContain("Late child completion.");
    await waitUntil(
      async () =>
        (await manager.getAgent(managerTask.threadId))?.status === "completed",
    );
    expect((await manager.getAgent(childTask.threadId))?.status).toBe(
      "canceled",
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
