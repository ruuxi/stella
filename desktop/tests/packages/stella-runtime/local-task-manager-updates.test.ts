import { describe, expect, it, vi } from "vitest";
import {
  LocalTaskManager,
  TASK_SHUTDOWN_CANCEL_REASON,
  type LocalTaskManagerAgentContext,
} from "../../../packages/runtime-kernel/tasks/local-task-manager.js";

const buildAgentContext = (): LocalTaskManagerAgentContext => ({
  systemPrompt: "system",
  dynamicContext: "",
  maxTaskDepth: 4,
  defaultSkills: [],
  skillIds: [],
});

const waitForCondition = async (condition: () => boolean, timeoutMs = 3_000) => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("LocalTaskManager task updates", () => {
  it("interrupts a running task and redelivers orchestrator updates on the next attempt", async () => {
    const taskEvents: Array<{ type: string; statusText?: string }> = [];
    let attemptCount = 0;

    const runSubagent = vi.fn(async ({
      taskPrompt,
      abortSignal,
    }: {
      taskPrompt: string;
      abortSignal: AbortSignal;
    }) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          runId: "run-1",
          result: "",
          error: "Interrupted by task update",
        };
      }

      return {
        runId: "run-2",
        result: taskPrompt,
      };
    });

    const manager = new LocalTaskManager({
      maxConcurrent: 1,
      onTaskEvent: (event) => {
        taskEvents.push({
          type: event.type,
          statusText: event.statusText,
        });
      },
      fetchAgentContext: vi.fn().mockResolvedValue(buildAgentContext()),
      runSubagent,
      toolExecutor: vi.fn(async () => ({ result: "ok" })),
      createCloudTaskRecord: vi.fn(),
      completeCloudTaskRecord: vi.fn(),
      getCloudTaskRecord: vi.fn(),
      cancelCloudTaskRecord: vi.fn(),
    });

    const created = await manager.createTask({
      conversationId: "conv-1",
      description: "Implement formatter",
      prompt: "Create the formatter and explain the result.",
      agentType: "general",
      storageMode: "local",
    });

    await waitForCondition(() => runSubagent.mock.calls.length >= 1);

    await expect(
      manager.sendTaskMessage(created.threadId, "Switch the output to JSON instead.", "orchestrator"),
    ).resolves.toEqual({ delivered: true });

    await waitForCondition(() => runSubagent.mock.calls.length >= 2);
    const restartedCall = runSubagent.mock.calls[1]?.[0] as { taskPrompt: string };
    expect(restartedCall.taskPrompt).toBe("Switch the output to JSON instead.");

    await waitForCondition(() =>
      taskEvents.some((event) => event.type === "task-completed"));

    const snapshot = await manager.getTask(created.threadId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.result).toBe("Switch the output to JSON instead.");
    expect(taskEvents.some((event) => event.statusText === "Applying task update")).toBe(true);
    expect(taskEvents.some((event) => event.type === "task-canceled")).toBe(false);
  });

  it("cancels pending and running tasks during shutdown", async () => {
    const taskEvents: Array<{ type: string; taskId?: string; error?: string }> = [];

    const runSubagent = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        runId: "run-1",
        result: "",
        error: TASK_SHUTDOWN_CANCEL_REASON,
      };
    });

    const manager = new LocalTaskManager({
      maxConcurrent: 1,
      onTaskEvent: (event) => {
        taskEvents.push({
          type: event.type,
          taskId: event.taskId,
          error: event.error,
        });
      },
      fetchAgentContext: vi.fn().mockResolvedValue(buildAgentContext()),
      runSubagent,
      toolExecutor: vi.fn(async () => ({ result: "ok" })),
      createCloudTaskRecord: vi.fn(),
      completeCloudTaskRecord: vi.fn(),
      getCloudTaskRecord: vi.fn(),
      cancelCloudTaskRecord: vi.fn(),
    });

    const runningTask = await manager.createTask({
      conversationId: "conv-1",
      description: "Running task",
      prompt: "Keep working.",
      agentType: "general",
      storageMode: "local",
    });
    const pendingTask = await manager.createTask({
      conversationId: "conv-1",
      description: "Pending task",
      prompt: "Wait your turn.",
      agentType: "general",
      storageMode: "local",
    });

    await waitForCondition(() =>
      taskEvents.some((event) =>
        event.type === "task-started" && event.taskId === runningTask.threadId));

    manager.shutdown();

    await waitForCondition(() =>
      taskEvents.filter((event) => event.type === "task-canceled").length >= 2);

    expect(taskEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task-canceled",
          taskId: runningTask.threadId,
          error: TASK_SHUTDOWN_CANCEL_REASON,
        }),
        expect.objectContaining({
          type: "task-canceled",
          taskId: pendingTask.threadId,
          error: TASK_SHUTDOWN_CANCEL_REASON,
        }),
      ]),
    );

    await expect(manager.getTask(runningTask.threadId)).resolves.toMatchObject({
      status: "canceled",
      error: TASK_SHUTDOWN_CANCEL_REASON,
    });
    await expect(manager.getTask(pendingTask.threadId)).resolves.toMatchObject({
      status: "canceled",
      error: TASK_SHUTDOWN_CANCEL_REASON,
    });
  });
});
