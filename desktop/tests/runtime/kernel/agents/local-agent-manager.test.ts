import { describe, expect, it } from "vitest";

import {
  AGENT_ORPHANED_RESTART_CANCEL_REASON,
  LocalAgentManager,
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
import type { TaskItem } from "@/features/chat/lib/event-transforms";
import {
  initialStoreState,
  streamStoreReducer,
} from "@/features/chat/streaming/store";
import { waitForAgentSettled } from "../../../helpers/agent.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("LocalAgentManager Exec fs locking", () => {
  it("cancels persisted running agents left behind by a previous worker", () => {
    const savedRecords: Parameters<
      NonNullable<
        ConstructorParameters<typeof LocalAgentManager>[0]["saveAgentRecord"]
      >
    >[0][] = [];

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
            ]
          : [],
      saveAgentRecord: (record) => {
        savedRecords.push(record);
      },
    });

    expect(savedRecords).toHaveLength(1);
    expect(savedRecords[0]).toMatchObject({
      threadId: "task-8",
      status: "canceled",
      completedAt: expect.any(Number),
      error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
    });
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
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async (args) => {
        contextFetches.push({
          agentType: args.agentType,
          model: args.model,
          spawnEngine: args.spawnEngine,
        });
        return {
          systemPrompt: "",
          dynamicContext: "",
          maxAgentDepth: 3,
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
    });

    const modelTask = await manager.createAgent({
      conversationId: "conv-1",
      description: "cheap task",
      prompt: "do work",
      agentType: "general",
      model: "stella/light",
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
        spawnEngine: undefined,
      },
      {
        agentType: "general",
        model: undefined,
        spawnEngine: { engine: "claude_code_local", model: "opus" },
      },
    ]);
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
        }),
        expect.objectContaining({
          type: "agent-completed",
          rootRunId: "root-current",
          agentId: task.threadId,
          result: "done-2",
        }),
      ]),
    );
    expect(resumedEvents.every((event) => event.rootRunId === "root-current"))
      .toBe(true);

    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId: "root-current",
      conversationId: "conv-1",
      userMessageId: "user-2",
    });
    resumedEvents.forEach((event, index) => {
      if (!event.agentId || !event.rootRunId) return;
      state = streamStoreReducer(state, {
        type: "tool-activity-observed",
        runId: event.rootRunId,
      });
      const terminal = event.type === "agent-completed";
      const nowMs = 1_000 + index;
      state = streamStoreReducer(state, {
        type: "task-upsert",
        runId: event.rootRunId,
        conversationId: "conv-1",
        userMessageId: "user-2",
        task: {
          id: event.agentId,
          description: event.description ?? "Task",
          agentType: event.agentType || AGENT_IDS.GENERAL,
          status: terminal ? "completed" : "running",
          anchorTurnId: "user-2",
          parentAgentId: event.parentAgentId,
          statusText: event.statusText,
          startedAtMs: nowMs,
          completedAtMs: terminal ? nowMs : undefined,
          lastUpdatedAtMs: nowMs,
          outputPreview: event.result,
        },
      });
    });

    const rootTasks = Object.values(
      state.tasksByRunId["root-current"] ?? {},
    ) as TaskItem[];
    expect(rootTasks).toHaveLength(1);
    expect(rootTasks[0]?.status).toBe("completed");
    expect(rootTasks.filter((task) => task.status === "running")).toEqual([]);
  });

  it("defers the Done display for interjection completions and flushes it when the thread resumes", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
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
            if (args.abortSignal.aborted) {
              resolve();
              return;
            }
            args.abortSignal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return { runId: args.runId, result: "", interrupted: true };
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

    // User message relayed mid-task: hard-cut interjection turn.
    await manager.sendAgentMessage(
      task.threadId,
      "how is it going?",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    await waitForCompletions(1);

    // The orchestrator hears about the completion immediately, but the
    // Done display is deferred — no audience-less / display-only event.
    expect(completions()).toHaveLength(1);
    expect(completions()[0]).toMatchObject({
      audience: "orchestrator-only",
      result: "done-2",
    });
    // Deferred display still pending → the thread counts as active work.
    expect(manager.getActiveAgentCount()).toBe(1);

    // Orchestrator resumes the thread: the deferred Done display must be
    // FLUSHED (not dropped) — the completion is real history and the chat
    // completion card renders on every completion (regression: resumed
    // threads showed no finish card because revival erased the deferred
    // display). The genuine completion of the resumed turn then displays
    // normally.
    await manager.sendAgentMessage(
      task.threadId,
      "continue the task",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    await waitForCompletions(3);

    const displayed = completions().filter(
      (event) => event.audience === "display-only",
    );
    expect(displayed).toHaveLength(1);
    expect(displayed[0]).toMatchObject({ result: "done-2" });
    // Flushed BEFORE the resumed turn's start events, so the activity fold
    // sees completed→started in order and the thread reads as running.
    const displayIndex = events.indexOf(displayed[0]!);
    const resumeProgressIndex = events.findIndex(
      (event, index) =>
        index > displayIndex &&
        event.type === "agent-progress" &&
        event.agentId === task.threadId,
    );
    expect(resumeProgressIndex).toBeGreaterThan(displayIndex);

    const final = completions().filter((event) => !event.audience);
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ result: "done-3" });
    expect(manager.getActiveAgentCount()).toBe(0);
  });

  it("flushes a deferred interjection Done display on shutdown", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const completions = () =>
      events.filter((event) => event.type === "agent-completed");

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
            if (args.abortSignal.aborted) {
              resolve();
              return;
            }
            args.abortSignal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return { runId: args.runId, result: "", interrupted: true };
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
    for (let attempt = 0; attempt < 100 && completions().length < 1; attempt += 1) {
      await sleep(25);
    }
    expect(completions()).toHaveLength(1);

    manager.shutdown();

    const displayed = completions().filter(
      (event) => event.audience === "display-only",
    );
    expect(displayed).toHaveLength(1);
    expect(displayed[0]).toMatchObject({ result: "done-2" });
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

describe("LocalAgentManager file records across send_input re-runs", () => {
  it("banks a send_input-interrupted run's files into the eventual completion rollup, then drains", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
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
            if (args.abortSignal.aborted) {
              resolve();
              return;
            }
            args.abortSignal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          // The interrupted run DID produce real files (e.g. rendered
          // videos in ~/.stella/outputs) before the send_input cut it off.
          return {
            runId: args.runId,
            result: "",
            interrupted: true,
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

    // send_input mid-run: aborts run 1 (its completion is never emitted)
    // and delivers the follow-up as the next turn on the same session.
    await manager.sendAgentMessage(
      task.threadId,
      "add music to the videos",
      "orchestrator",
      { rootRunId: "root-2" },
    );
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

    // Resume the thread. The revival flushes the deferred display-only
    // copy of the first completion (same rollup — it's the same completion
    // reaching the display surfaces), then the bank was drained at
    // emission, so the resumed run's own completion only reveals the new
    // run's files (append-only property).
    await manager.sendAgentMessage(
      task.threadId,
      "export a final pdf",
      "orchestrator",
      { rootRunId: "root-3" },
    );
    await waitForCompletions(3);

    const flushedDisplay = completions().find(
      (event) => event.audience === "display-only",
    )!;
    expect(flushedDisplay.producedFiles).toEqual(first.producedFiles);

    const second = completions().find(
      (event) => !event.audience && event.result === "done-3",
    )!;
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
