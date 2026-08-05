import { describe, expect, it } from "vitest";

import {
  AGENT_ORPHANED_RESTART_CANCEL_REASON,
  LocalAgentManager,
  sanitizeTaskToolArgsHint,
} from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import type { AgentLifecycleEvent } from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import {
  createStateContext,
  handleSendInput,
} from "../../../../../runtime/kernel/tools/state.js";
import type {
  ToolContext,
  ToolResult,
} from "../../../../../runtime/kernel/tools/types.js";
import {
  __privateTaskDecorationStore,
  clearTaskDecoration,
  decorateTask,
  getTaskDecoration,
} from "@/features/chat/streaming/task-decoration-store";
import { waitForAgentSettled } from "../../../helpers/agent.js";
import type { PersistedAgentRecord } from "../../../../../runtime/kernel/storage/session-store.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("task tool activity sanitization", () => {
  it("redacts environment and credential values before renderer delivery", () => {
    const hint = sanitizeTaskToolArgsHint({
      cmd: "OPENAI_API_KEY=sk-secret curl --token top-secret https://example.com?access_token=url-secret",
      env: { PUBLIC_MODE: "debug", PRIVATE_VALUE: "hidden" },
      password: "also-hidden",
    });

    expect(hint).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(hint).toContain("--token [REDACTED]");
    expect(hint).toContain("access_token=[REDACTED]");
    expect(hint).not.toContain("sk-secret");
    expect(hint).not.toContain("top-secret");
    expect(hint).not.toContain("url-secret");
    expect(hint).not.toContain("debug");
    expect(hint).not.toContain("hidden");
  });
});

describe("LocalAgentManager Exec fs locking", () => {
  it("cancels persisted running agents left behind by a previous worker", () => {
    const savedRecords: Parameters<
      NonNullable<
        ConstructorParameters<typeof LocalAgentManager>[0]["saveAgentRecord"]
      >
    >[0][] = [];
    const lifecycleEvents: AgentLifecycleEvent[] = [];

    new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => ({
        runId: args.runId,
        result: "unused",
      }),
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
      listAgentRecordsByStatus: (status) =>
        status === "running"
          ? [
              {
                threadId: "task-8",
                conversationId: "conv-1",
                agentType: "general",
                description: "stale agent task",
                agentDepth: 0,
                status: "running",
                startedAt: 123,
                completedAt: null,
                updatedAt: 456,
              },
              {
                threadId: "task-9",
                conversationId: "conv-1",
                agentType: "general",
                description: "second stale agent task",
                agentDepth: 0,
                status: "running",
                startedAt: 234,
                completedAt: null,
                updatedAt: 567,
              },
            ]
          : [],
      saveAgentRecord: (record) => {
        savedRecords.push(record);
      },
      onAgentEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    expect(savedRecords).toHaveLength(2);
    expect(savedRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "task-8",
          status: "canceled",
          completedAt: expect.any(Number),
          error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        }),
        expect.objectContaining({
          threadId: "task-9",
          status: "canceled",
          completedAt: expect.any(Number),
          error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        }),
      ]),
    );
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({
        type: "agent-canceled",
        conversationId: "conv-1",
        agentId: "task-8",
        error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        audience: "display-only",
      }),
      expect.objectContaining({
        type: "agent-canceled",
        conversationId: "conv-1",
        agentId: "task-9",
        error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        audience: "display-only",
      }),
    ]);
  });

  it("repairs a pending completion boundary exactly once after restart", () => {
    const completionEventId = "repair-task:3:agent-completed";
    let persisted: PersistedAgentRecord = {
      threadId: "repair-task",
      conversationId: "repair-conversation",
      agentType: AGENT_IDS.GENERAL,
      description: "Repair interrupted completion",
      agentDepth: 1,
      status: "running",
      attemptGeneration: 3,
      startedAt: 100,
      completedAt: null,
      result: "Durable final result.",
      descendantBoundaryState: {
        consumedEventIds: [],
        wakePending: false,
        pendingCompletionEventId: completionEventId,
      },
      updatedAt: 200,
    };
    const lifecycleEvents: AgentLifecycleEvent[] = [];
    const createManager = () =>
      new LocalAgentManager({
        maxConcurrent: 1,
        fetchAgentContext: async () => ({
          systemPrompt: "",
          dynamicContext: "",
          maxAgentDepth: 3,
        }),
        runSubagent: async (args) => ({
          runId: args.runId,
          result: "unused",
        }),
        toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
        createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
        completeCloudAgentRecord: async () => undefined,
        getCloudAgentRecord: async () => null,
        cancelCloudAgentRecord: async () => ({ canceled: false }),
        listAgentRecordsByStatus: (status) =>
          status === "running" && persisted.status === "running"
            ? [persisted]
            : [],
        getAgentRecord: (threadId) =>
          threadId === persisted.threadId ? persisted : null,
        saveAgentRecord: (record) => {
          persisted = record;
        },
        onAgentEvent: (event) => {
          lifecycleEvents.push(event);
        },
        hasAgentLifecycleEvent: () => false,
      });

    const first = createManager();
    expect(persisted.status).toBe("running");
    expect(lifecycleEvents).toEqual([]);

    first.repairInterruptedDescendantBoundaries();
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({
        type: "agent-completed",
        eventId: completionEventId,
        agentId: "repair-task",
        attemptGeneration: 3,
        result: "Durable final result.",
      }),
    ]);
    expect(persisted).toMatchObject({
      status: "completed",
      completedAt: expect.any(Number),
    });
    expect(
      persisted.descendantBoundaryState?.pendingCompletionEventId,
    ).toBeUndefined();

    first.repairInterruptedDescendantBoundaries();
    const second = createManager();
    second.repairInterruptedDescendantBoundaries();
    expect(lifecycleEvents).toHaveLength(1);
  });

  it("emits completed terminal events with the agent result and file changes", async () => {
    const events: AgentLifecycleEvent[] = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => ({
        runId: args.runId,
        result: "Agent finished the delegated work.",
        fileChanges: [
          {
            path: "/repo/src/agent-change.ts",
            kind: { type: "update" },
          },
        ],
      }),
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "agent task",
      prompt: "do agent work",
      agentType: "general",
      storageMode: "local",
    });

    await waitForAgentSettled(manager, task.threadId);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent-completed",
        conversationId: "conv-1",
        agentId: task.threadId,
        agentType: "general",
        description: "agent task",
        result: "Agent finished the delegated work.",
        fileChanges: [
          {
            path: "/repo/src/agent-change.ts",
            kind: { type: "update" },
          },
        ],
      }),
    );
  });

  it("threads per-spawn model and engine selections into the agent context fetch", async () => {
    const contextFetches: Array<Record<string, unknown>> = [];
    const savedRecords: PersistedAgentRecord[] = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async (args) => {
        contextFetches.push({
          agentType: args.agentType,
          model: args.model,
          spawnEngine: args.spawnEngine,
          spawnReasoningEffort: args.spawnReasoningEffort,
        });
        const modelConfigSnapshot =
          args.spawnEngine?.engine === "claude_code_local"
            ? {
                engine: "claude_code_local" as const,
                routeModel: "anthropic/claude-opus-4-7",
                engineModel: "opus",
              }
            : {
                engine: "default" as const,
                routeModel: args.model ?? "stella/standard",
                reasoningEffort: args.spawnReasoningEffort,
              };
        return {
          systemPrompt: "",
          dynamicContext: "",
          maxAgentDepth: 3,
          modelConfigSnapshot,
        };
      },
      runSubagent: async (args) => ({
        runId: args.runId,
        result: "done",
      }),
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
      saveAgentRecord: (record) => {
        savedRecords.push(record);
      },
    });

    const modelTask = await manager.createAgent({
      conversationId: "conv-1",
      description: "cheap task",
      prompt: "do work",
      agentType: "general",
      model: "stella/light",
      spawnEngine: { engine: "default" },
      spawnReasoningEffort: "high",
      storageMode: "local",
    });
    await waitForAgentSettled(manager, modelTask.threadId);

    const engineTask = await manager.createAgent({
      conversationId: "conv-1",
      description: "cc task",
      prompt: "do work",
      agentType: "general",
      spawnEngine: { engine: "claude_code_local", model: "opus" },
      storageMode: "local",
    });
    await waitForAgentSettled(manager, engineTask.threadId);

    expect(contextFetches).toEqual([
      {
        agentType: "general",
        model: "stella/light",
        spawnEngine: { engine: "default" },
        spawnReasoningEffort: "high",
      },
      {
        agentType: "general",
        model: undefined,
        spawnEngine: { engine: "claude_code_local", model: "opus" },
        spawnReasoningEffort: undefined,
      },
    ]);
    expect(savedRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: modelTask.threadId,
          modelConfigSnapshot: {
            engine: "default",
            routeModel: "stella/light",
            reasoningEffort: "high",
          },
        }),
        expect.objectContaining({
          threadId: engineTask.threadId,
          modelConfigSnapshot: {
            engine: "claude_code_local",
            routeModel: "anthropic/claude-opus-4-7",
            engineModel: "opus",
          },
        }),
      ]),
    );
  });

  it("persists a spawn-time model snapshot before a queued agent begins", async () => {
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let runCount = 0;
    const savedRecords = new Map<string, PersistedAgentRecord>();
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async (args) => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
        modelConfigSnapshot: args.modelConfigSnapshot,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) await blocker;
        return { runId: args.runId, result: "done" };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
      saveAgentRecord: (record) => {
        savedRecords.set(record.threadId, record);
      },
    });

    const first = await manager.createAgent({
      conversationId: "conv-queued-snapshot",
      description: "slot blocker",
      prompt: "hold the only slot",
      agentType: "general",
      storageMode: "local",
    });
    for (let index = 0; index < 100 && runCount === 0; index += 1) {
      await sleep(1);
    }
    expect(runCount).toBe(1);

    const snapshot = {
      engine: "claude_code_local" as const,
      subscriptionHarnessEnabled: true,
      routeModel: "stella/openai/gpt-5.6-sol",
      engineModel: "opus",
      reasoningEffort: "high" as const,
    };
    const queued = await manager.createAgent({
      conversationId: "conv-queued-snapshot",
      description: "queued explicit Claude",
      prompt: "wait for the slot",
      agentType: "general",
      spawnEngine: { engine: "claude_code_local", model: "opus" },
      modelConfigSnapshot: snapshot,
      storageMode: "local",
    });

    expect(runCount).toBe(1);
    expect(savedRecords.get(queued.threadId)).toMatchObject({
      status: "running",
      modelConfigSnapshot: snapshot,
    });

    releaseBlocker();
    await waitForAgentSettled(manager, first.threadId);
    await waitForAgentSettled(manager, queued.threadId);
  });

  it("exposes active background agent root runs", async () => {
    let releaseRun: (() => void) | null = null;
    const running = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        await running;
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "background task",
      prompt: "do work",
      agentType: "general",
      rootRunId: "root-run-1",
      storageMode: "local",
    });

    expect(manager.listActiveAgentRuns()).toEqual([
      { runId: "root-run-1", conversationId: "conv-1" },
    ]);

    releaseRun?.();
    await waitForAgentSettled(manager, task.threadId);
    expect(manager.listActiveAgentRuns()).toEqual([]);
  });

  it("routes send_input task lifecycle through the current root run and clears composer chip state on completion", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let secondRunStarted: (() => void) | null = null;
    const secondRunStartedPromise = new Promise<void>((resolve) => {
      secondRunStarted = resolve;
    });
    let finishSecondRun: (() => void) | null = null;
    const finishSecondRunPromise = new Promise<void>((resolve) => {
      finishSecondRun = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 2) {
          secondRunStarted?.();
          await finishSecondRunPromise;
        }
        return {
          runId: args.runId,
          result: `done-${runCount}`,
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "Research current Nvidia news",
      prompt: "Research current Nvidia news",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-original",
      storageMode: "local",
    });
    await waitForAgentSettled(manager, task.threadId);

    const eventOffset = events.length;
    const toolContext = createStateContext("/tmp", {
      createAgent: async (request) => manager.createAgent(request),
      getAgent: async (threadId) => manager.getAgent(threadId),
      cancelAgent: async (threadId, reason) =>
        manager.cancelAgent(threadId, reason),
      sendAgentMessage: async (threadId, message, from, options) =>
        manager.sendAgentMessage(threadId, message, from, options),
    });

    await expect(
      handleSendInput(
        toolContext,
        {
          thread_id: task.threadId,
          message: "resume the web research with the new requirement",
          description: "Resume current Nvidia web research",
        },
        {
          conversationId: "conv-1",
          deviceId: "device-1",
          requestId: "request-2",
          rootRunId: "root-current",
          agentType: AGENT_IDS.ORCHESTRATOR,
        },
      ),
    ).resolves.toMatchObject({
      result: {
        thread_id: task.threadId,
        status: "updated",
        delivered: true,
      },
    });

    await secondRunStartedPromise;
    expect(manager.listActiveAgentRuns()).toEqual([
      { runId: "root-current", conversationId: "conv-1" },
    ]);

    finishSecondRun?.();
    await waitForAgentSettled(manager, task.threadId);

    // The initial spawn's agent-started is NOT flagged a follow-up.
    const spawnStarted = events
      .slice(0, eventOffset)
      .find(
        (event) =>
          event.type === "agent-started" && event.agentId === task.threadId,
      );
    expect(spawnStarted).toBeDefined();
    expect(spawnStarted?.isFollowUp).toBeUndefined();
    expect(spawnStarted?.attemptGeneration).toBe(1);

    const resumedEvents = events.slice(eventOffset);
    // The send_input re-activation IS explicitly flagged a follow-up, and
    // carries the follow-up's own message on `statusText`.
    expect(resumedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent-started",
          rootRunId: "root-current",
          agentId: task.threadId,
          statusText: "Resume current Nvidia web research",
          isFollowUp: true,
          attemptGeneration: expect.any(Number),
        }),
        expect.objectContaining({
          type: "agent-completed",
          rootRunId: "root-current",
          agentId: task.threadId,
          result: "done-2",
        }),
      ]),
    );
    expect(
      resumedEvents.every((event) => event.rootRunId === "root-current"),
    ).toBe(true);
    const resumedStart = resumedEvents.find(
      (event) => event.type === "agent-started",
    );
    const resumedTerminal = resumedEvents.find(
      (event) => event.type === "agent-completed",
    );
    expect(resumedStart?.attemptGeneration).toBeGreaterThan(
      spawnStarted?.attemptGeneration ?? 0,
    );
    expect(resumedTerminal?.attemptGeneration).toBe(
      resumedStart?.attemptGeneration,
    );

    // Renderer side: the follow-up's stream events maintain only the
    // ephemeral decoration (keyed by thread, rebound to the current run),
    // and the completion clears it — no per-run task copies to leak.
    for (const event of resumedEvents) {
      if (!event.agentId) continue;
      if (event.type === "agent-completed") {
        clearTaskDecoration(event.agentId);
        continue;
      }
      decorateTask({
        agentId: event.agentId,
        conversationId: "conv-1",
        runId: event.rootRunId,
        statusText: event.statusText,
      });
      expect(getTaskDecoration(event.agentId)?.runId).toBe("root-current");
    }
    // Completion left no lingering decoration behind.
    expect(getTaskDecoration(task.threadId)).toBeUndefined();
    __privateTaskDecorationStore.resetForTests();
  });

  it("steers a live Pi turn without aborting or starting a replacement run", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let firstRunWasAborted = false;
    let steeringPrompt = "";
    let releaseFirstRun: (() => void) | null = null;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const completions = () =>
      events.filter((event) => event.type === "agent-completed");
    const waitForCompletions = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (completions().length >= count) return;
        await sleep(25);
      }
      throw new Error(`Expected ${count} completion event(s) in time.`);
    };

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          Object.defineProperty(args.subagentSession, "canSteer", {
            configurable: true,
            get: () => true,
          });
          Object.defineProperty(args.subagentSession, "steer", {
            configurable: true,
            value: (text: string) => {
              steeringPrompt = text;
              releaseFirstRun?.();
              return true;
            },
          });
          firstRunStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
          firstRunWasAborted = args.abortSignal.aborted;
        }
        return { runId: args.runId, result: `done-${runCount}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "long research task",
      prompt: "do long research",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    await manager.sendAgentMessage(
      task.threadId,
      "how is it going?",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    await waitForCompletions(1);

    expect(firstRunWasAborted).toBe(false);
    expect(runCount).toBe(1);
    expect(steeringPrompt).toContain("how is it going?");
    expect(steeringPrompt).not.toContain("paused");
    expect(completions()).toHaveLength(1);
    expect(completions()[0]).toMatchObject({ result: "done-1" });
    expect(completions()[0]?.audience).toBeUndefined();
    const startedEvents = events.filter(
      (event) => event.type === "agent-started",
    );
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[1]).toMatchObject({
      rootRunId: "root-2",
      agentId: task.threadId,
      statusText: "how is it going?",
      isFollowUp: true,
      // A steering receipt is a new UI occurrence on the same live attempt,
      // not evidence of an engine restart.
      attemptGeneration: startedEvents[0]?.attemptGeneration,
    });
    // Fully finished — nothing pending keeps the thread "active".
    expect(manager.getActiveAgentCount()).toBe(0);

    // Orchestrator resumes the now-idle thread: that's a NEW run with its
    // own completion card at its own completion. Done → running-again is
    // honest history, not a glitch to suppress.
    await manager.sendAgentMessage(
      task.threadId,
      "continue the task",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    await waitForCompletions(2);

    expect(completions()).toHaveLength(2);
    expect(completions()[1]).toMatchObject({ result: "done-2" });
    expect(completions()[1]?.audience).toBeUndefined();
    expect(
      events.every(
        (event) =>
          event.audience !== "display-only" &&
          event.audience !== "orchestrator-only",
      ),
    ).toBe(true);
    expect(manager.getActiveAgentCount()).toBe(0);
  });

  it("queues input when no live Pi loop can steer, then continues after natural completion", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let releaseFirstRun: (() => void) | null = null;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const completions = () =>
      events.filter((event) => event.type === "agent-completed");
    const waitForCompletions = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (completions().length >= count) return;
        await sleep(25);
      }
      throw new Error(`Expected ${count} completion event(s) in time.`);
    };

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          firstRunStarted?.();
          // This mock does not create a live Pi Agent, so send_input must
          // stay queued while the current engine run finishes naturally.
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
          return { runId: args.runId, result: "done-1" };
        }
        return { runId: args.runId, result: `done-${runCount}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "racy task",
      prompt: "do the work",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    await manager.sendAgentMessage(
      task.threadId,
      "one more thing",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    releaseFirstRun?.();

    await waitForCompletions(1);
    // Exactly one completion: the queued continuation's. The naturally
    // finished internal boundary (done-1) never emitted a completion card.
    expect(completions()).toHaveLength(1);
    expect(completions()[0]).toMatchObject({ result: "done-2" });
    expect(completions()[0]?.audience).toBeUndefined();
    expect(completions().every((event) => event.result !== "done-1")).toBe(
      true,
    );
    expect(manager.getActiveAgentCount()).toBe(0);
  });

  it("emits failed terminal events when an engine turn throws", async () => {
    const events: AgentLifecycleEvent[] = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async () => {
        throw new Error("engine transport failed");
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "broken engine task",
      prompt: "do work",
      agentType: "general",
      storageMode: "local",
    });

    await waitForAgentSettled(manager, task.threadId);

    await expect(manager.getAgent(task.threadId)).resolves.toMatchObject({
      status: "error",
      error: "engine transport failed",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent-failed",
        conversationId: "conv-1",
        agentId: task.threadId,
        agentType: "general",
        error: "engine transport failed",
      }),
    );
  });

  it("serializes mutating Exec calls across concurrent tasks", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        const toolContext: ToolContext = {
          conversationId: args.conversationId,
          deviceId: "device-1",
          requestId: `${args.runId}-req`,
          agentType: args.agentType,
          storageMode: "local",
        };
        await args.toolExecutor(
          "Exec",
          {
            summary: "mutate files",
            source: `await tools.apply_patch({ patch: "*** Begin Patch\\n*** End Patch\\n" });`,
          },
          toolContext,
          args.abortSignal,
        );
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (
        toolName: string,
        _args: Record<string, unknown>,
        _context: ToolContext,
      ): Promise<ToolResult> => {
        expect(toolName).toBe("Exec");
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        try {
          await sleep(75);
        } finally {
          activeCalls -= 1;
        }
        return { result: "ok" };
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createAgent({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "general",
      storageMode: "local",
    });
    const second = await manager.createAgent({
      conversationId: "conv-1",
      description: "second",
      prompt: "second prompt",
      agentType: "general",
      storageMode: "local",
    });

    await Promise.all([
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    await expect(manager.getAgent(first.threadId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(manager.getAgent(second.threadId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(maxConcurrentCalls).toBe(1);
  });

  it("allows concurrent Codex engine runs", async () => {
    let activeRuns = 0;
    let maxConcurrentRuns = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        agentEngine: "codex_cli",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        activeRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
        try {
          await sleep(75);
        } finally {
          activeRuns -= 1;
        }
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createAgent({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "general",
      storageMode: "local",
    });
    const second = await manager.createAgent({
      conversationId: "conv-1",
      description: "second",
      prompt: "second prompt",
      agentType: "general",
      storageMode: "local",
    });

    await Promise.all([
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    expect(maxConcurrentRuns).toBe(2);
  });

  it("allows concurrent General Codex engine runs", async () => {
    let activeRuns = 0;
    let maxConcurrentRuns = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        agentEngine: "codex_cli",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        activeRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
        try {
          await sleep(75);
        } finally {
          activeRuns -= 1;
        }
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createAgent({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "general",
      storageMode: "local",
    });
    const second = await manager.createAgent({
      conversationId: "conv-1",
      description: "second",
      prompt: "second prompt",
      agentType: "general",
      storageMode: "local",
    });

    await Promise.all([
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    expect(maxConcurrentRuns).toBe(2);
  });
});

describe("LocalAgentManager file records across queued send_input turns", () => {
  it("banks a naturally finished internal boundary into the eventual completion rollup, then drains", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let releaseFirstRun: (() => void) | null = null;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const completions = () =>
      events.filter((event) => event.type === "agent-completed");
    const waitForCompletions = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (completions().length >= count) return;
        await sleep(25);
      }
      throw new Error(`Expected ${count} completion event(s) in time.`);
    };

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          firstRunStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
          // This mock has no live Pi Agent, so the current engine run
          // finishes naturally before the queued update becomes turn 2.
          return {
            runId: args.runId,
            result: "done-1",
            fileChanges: [
              {
                path: "/home/u/.stella/outputs/demos/review.html",
                kind: { type: "update" as const },
              },
            ],
            producedFiles: [
              {
                path: "/home/u/.stella/outputs/demos/demo1.mp4",
                kind: { type: "add" as const },
              },
            ],
          };
        }
        if (runCount === 2) {
          // Follow-up run re-reports one banked write (dedupe) and adds a
          // new one.
          return {
            runId: args.runId,
            result: `done-${runCount}`,
            producedFiles: [
              {
                path: "/home/u/.stella/outputs/demos/demo1.mp4",
                kind: { type: "add" as const },
              },
              {
                path: "/home/u/.stella/outputs/demos/demo2.mp4",
                kind: { type: "add" as const },
              },
            ],
          };
        }
        // Post-drain run: only its own new file.
        return {
          runId: args.runId,
          result: `done-${runCount}`,
          producedFiles: [
            {
              path: "/home/u/.stella/outputs/demos/final.pdf",
              kind: { type: "add" as const },
            },
          ],
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "render demo videos",
      prompt: "render the demos",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    // No live Pi loop is available in this mock. The update queues without
    // aborting run 1, then becomes the next turn once run 1 finishes.
    await manager.sendAgentMessage(
      task.threadId,
      "add music to the videos",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    releaseFirstRun?.();
    await waitForCompletions(1);

    // The first EMITTED completion must carry run 1's banked files merged
    // with run 2's, deduped by path+kind.
    const first = completions()[0]!;
    expect(first.fileChanges).toEqual([
      {
        path: "/home/u/.stella/outputs/demos/review.html",
        kind: { type: "update" },
      },
    ]);
    expect(first.producedFiles).toEqual([
      {
        path: "/home/u/.stella/outputs/demos/demo1.mp4",
        kind: { type: "add" },
      },
      {
        path: "/home/u/.stella/outputs/demos/demo2.mp4",
        kind: { type: "add" },
      },
    ]);

    // Resume the now-idle thread: the bank was drained when the first
    // completion emitted, so the resumed run's own completion only reveals
    // the new run's files (append-only property). No audience-split
    // duplicates exist under the state-based completion rule.
    await manager.sendAgentMessage(
      task.threadId,
      "export a final pdf",
      "orchestrator",
      { rootRunId: "root-3" },
    );
    await waitForCompletions(2);

    expect(completions()).toHaveLength(2);
    const second = completions()[1]!;
    expect(second.audience).toBeUndefined();
    expect(second.result).toBe("done-3");
    expect(second.fileChanges).toBeUndefined();
    expect(second.producedFiles).toEqual([
      {
        path: "/home/u/.stella/outputs/demos/final.pdf",
        kind: { type: "add" },
      },
    ]);
  });

  it("advances snapshot lastActivityAt on tool lifecycle during one long tool call", async () => {
    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let toolStarted: (() => void) | undefined;
    const toolStartedPromise = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      // Simulates a run whose only activity is one slow tool: no streamed
      // progress (onProgress never fires), just a tool_start then a long wait.
      runSubagent: async (args) => {
        args.onToolStart?.({
          runId: args.runId,
          seq: 1,
          toolCallId: "call-1",
          toolName: "exec_command",
          statusText: "Running exec_command",
        });
        toolStarted?.();
        await runGate;
        args.onToolEnd?.({
          runId: args.runId,
          seq: 2,
          toolCallId: "call-1",
          toolName: "exec_command",
          resultPreview: "ok",
        });
        return { runId: args.runId, result: "done" };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const beforeCreate = Date.now();
    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "slow connector probe",
      prompt: "probe the connector",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await toolStartedPromise;

    const midToolSnapshot = await manager.getAgent(task.threadId);
    expect(midToolSnapshot?.status).toBe("running");
    // Tool start stamped liveness and marked the tool in flight.
    expect(midToolSnapshot?.lastActivityAt).toBeGreaterThanOrEqual(
      beforeCreate,
    );
    expect(midToolSnapshot?.activeToolCount).toBe(1);
    expect(midToolSnapshot?.recentActivity).toEqual(["Running exec_command"]);

    // Real manager behavior while the tool keeps running: the stamp does
    // NOT move (nothing re-stamps it mid-call) — `activeToolCount` is the
    // only signal that the agent isn't idle. This is exactly the window
    // where a stamp-only idle test would wrongly cancel.
    const stampAfterStart = midToolSnapshot?.lastActivityAt ?? 0;
    await sleep(30);
    const stillMidToolSnapshot = await manager.getAgent(task.threadId);
    expect(stillMidToolSnapshot?.lastActivityAt).toBe(stampAfterStart);
    expect(stillMidToolSnapshot?.activeToolCount).toBe(1);

    releaseRun?.();
    await waitForAgentSettled(manager, task.threadId);

    const finalSnapshot = await manager.getAgent(task.threadId);
    expect(finalSnapshot?.status).toBe("completed");
    // Tool end bumped the stamp past the tool-start one and cleared the
    // in-flight count.
    expect(finalSnapshot?.lastActivityAt).toBeGreaterThan(stampAfterStart);
    expect(finalSnapshot?.activeToolCount).toBe(0);
  });
});

describe("send_input follow-up description and run rebind", () => {
  it.each([
    [AGENT_IDS.GENERAL, "completed"],
    [AGENT_IDS.GENERAL, "canceled"],
  ] as const)(
    "persists a resumed %s %s thread as running immediately and settles it",
    async (agentType, terminalStatus) => {
      const threadId = `${agentType}-${terminalStatus}-resume`;
      const persisted: PersistedAgentRecord = {
        threadId,
        conversationId: "conv-resume-activity",
        agentType,
        description: "Original work",
        agentDepth: 2,
        status: terminalStatus,
        attemptGeneration: 3,
        startedAt: 100,
        completedAt: 200,
        updatedAt: 200,
      };
      const saved: PersistedAgentRecord[] = [];
      const events: AgentLifecycleEvent[] = [];
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const manager = new LocalAgentManager({
        maxConcurrent: 1,
        fetchAgentContext: async () => ({
          systemPrompt: "",
          dynamicContext: "",
          maxAgentDepth: 4,
        }),
        runSubagent: async (args) => {
          markStarted();
          await gate;
          return { runId: args.runId, result: "Resumed parent reply" };
        },
        toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
        getAgentRecord: (candidate) =>
          candidate === threadId ? persisted : null,
        saveAgentRecord: (record) => saved.push({ ...record }),
        onAgentEvent: (event) => events.push(event),
        resolveTaskThread: () => ({
          threadId,
          conversationId: persisted.conversationId,
          agentType,
          name: "Resumed thread",
          createdAt: 100,
          lastUsedAt: 200,
        }),
        createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
        completeCloudAgentRecord: async () => undefined,
        getCloudAgentRecord: async () => null,
        cancelCloudAgentRecord: async () => ({ canceled: false }),
      });

      await expect(
        manager.sendAgentMessage(
          threadId,
          "Apply the resumed requirement",
          "orchestrator",
          { deliveryKind: "external-input", rootRunId: "root-resumed" },
        ),
      ).resolves.toEqual({ delivered: true });
      await started;

      expect(saved.at(-1)).toMatchObject({
        threadId,
        status: "running",
        attemptGeneration: 4,
        rootRunId: "root-resumed",
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "agent-started",
          agentId: threadId,
          isFollowUp: true,
          attemptGeneration: 4,
        }),
      );

      finish();
      await waitForAgentSettled(manager, threadId);
      expect(saved.at(-1)).toMatchObject({
        threadId,
        status: "completed",
        attemptGeneration: 4,
        result: "Resumed parent reply",
      });
    },
  );

  it("adopts the orchestrator follow-up description onto the thread", async () => {
    // The folded Activity row is keyed per thread and titled by
    // `description`. A follow-up re-tasks the thread, so every lifecycle
    // event after the send_input must carry the follow-up's description —
    // not the original spawn text frozen forever.
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let releaseFirstRun: (() => void) | null = null;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          firstRunStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
          return { runId: args.runId, result: "done-1" };
        }
        return { runId: args.runId, result: `done-${runCount}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "find the booked itinerary",
      prompt: "find the booked itinerary",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    await manager.sendAgentMessage(
      task.threadId,
      "search specifically for the forwarded itinerary email",
      "orchestrator",
      {
        description: "search for the itinerary email",
        rootRunId: "root-2",
      },
    );
    releaseFirstRun?.();
    await waitForAgentSettled(manager, task.threadId);

    const followUpStarted = events.find(
      (event) => event.type === "agent-started" && event.isFollowUp,
    );
    expect(followUpStarted).toMatchObject({
      rootRunId: "root-2",
      description: "search for the itinerary email",
    });
    const completion = events.find((event) => event.type === "agent-completed");
    expect(completion).toMatchObject({
      rootRunId: "root-2",
      description: "search for the itinerary email",
    });
    // The updated description sticks on the thread snapshot too.
    const snapshot = await manager.getAgent(task.threadId);
    expect(snapshot?.description).toBe("search for the itinerary email");
  });

  it("rebinds a thread's decoration to the follow-up's run without leaking per-run copies", () => {
    // The old per-run task store leaked a frozen "running" copy under the
    // spawn run when send_input rebound a thread to the caller's run —
    // that copy pinned the Activity row open forever. Decorations are
    // keyed by thread: a rebind is an in-place update, and the terminal
    // stream event clears it. Authoritative status lives in the
    // thread-activity rows and never depends on this map.
    decorateTask({
      agentId: "thread-1",
      conversationId: "conv-1",
      runId: "root-1",
      statusText: "find the booked itinerary",
      startsAttempt: true,
    });
    expect(getTaskDecoration("thread-1")?.runId).toBe("root-1");

    // Follow-up streams under the new run: same single entry, new runId.
    decorateTask({
      agentId: "thread-1",
      conversationId: "conv-1",
      runId: "root-2",
      statusText: "search for the itinerary email",
      startsAttempt: true,
    });
    expect(getTaskDecoration("thread-1")).toMatchObject({
      runId: "root-2",
      statusText: "search for the itinerary email",
    });

    clearTaskDecoration("thread-1");
    expect(getTaskDecoration("thread-1")).toBeUndefined();
    __privateTaskDecorationStore.resetForTests();
  });
});
