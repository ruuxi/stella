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

    const resumedEvents = events.slice(eventOffset);
    expect(resumedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent-started",
          rootRunId: "root-current",
          agentId: task.threadId,
          statusText: "Resume current Nvidia web research",
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

  it("defers the Done display for interjection completions and drops it when the thread resumes", async () => {
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
    // dropped, and the genuine completion of the resumed turn displays
    // normally.
    await manager.sendAgentMessage(
      task.threadId,
      "continue the task",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    await waitForCompletions(2);

    expect(completions()).toHaveLength(2);
    expect(completions()[1]).toMatchObject({ result: "done-3" });
    expect(completions()[1]?.audience).toBeUndefined();
    expect(events.some((event) => event.audience === "display-only")).toBe(
      false,
    );
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
