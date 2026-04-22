import { describe, expect, it } from "vitest";

import {
  LocalTaskManager,
  TASK_PAUSE_CANCEL_REASON,
  type TaskLifecycleEvent,
} from "../../../../../runtime/kernel/tasks/local-task-manager.js";
import type { ToolResult } from "../../../../../runtime/kernel/tools/types.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForTaskCompletion = async (
  manager: LocalTaskManager,
  taskId: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await manager.getTask(taskId);
    if (snapshot && snapshot.status !== "running") {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Task ${taskId} did not finish in time.`);
};

describe("LocalTaskManager TaskPause cancellation", () => {
  it("suppresses in-flight task-progress events after the task is canceled", async () => {
    // Reproduces the regression that left a phantom "Working … Task" chip
    // in the chat footer after TaskPause: the agent loop iterates over
    // every tool call in the latest assistant message, so it kept firing
    // `tool_execution_start` (and therefore `onToolStart`) after
    // `cancelTask` had already marked the task canceled, leaking
    // `task-progress` lifecycle events that flipped the task back to
    // running on the desktop.
    const lifecycleEvents: TaskLifecycleEvent[] = [];

    let onToolStartHook: ((toolName: string) => void) | null = null;
    let cancelGate: (() => void) | null = null;
    const cancelGatePromise = new Promise<void>((resolve) => {
      cancelGate = resolve;
    });

    const manager = new LocalTaskManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxTaskDepth: 3,
      }),
      runSubagent: async (args) => {
        onToolStartHook = (toolName) =>
          args.onToolStart?.({ toolName } as never);

        // Simulate an in-flight tool call that fires *before* the orchestrator
        // gets a chance to call cancelTask.
        onToolStartHook("Read");
        cancelGate?.();

        // Wait until cancelTask has finished setting status === "canceled",
        // then keep iterating over the remaining tool calls in the same
        // assistant message — these post-cancel onToolStart fires must be
        // ignored by LocalTaskManager.
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            args.abortSignal?.removeEventListener("abort", onAbort);
            try {
              onToolStartHook?.("Write");
              onToolStartHook?.("Edit");
            } catch (error) {
              reject(error as Error);
              return;
            }
            resolve();
          };
          if (args.abortSignal?.aborted) {
            onAbort();
            return;
          }
          args.abortSignal?.addEventListener("abort", onAbort, { once: true });
        });

        return { runId: args.runId, result: "" };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "ok" }),
      createCloudTaskRecord: async () => ({ taskId: "cloud-unused" }),
      completeCloudTaskRecord: async () => undefined,
      getCloudTaskRecord: async () => null,
      cancelCloudTaskRecord: async () => ({ canceled: false }),
      onTaskEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    const created = await manager.createTask({
      conversationId: "conv-1",
      description: "demo",
      prompt: "demo prompt",
      agentType: "general",
      storageMode: "local",
    });

    await cancelGatePromise;
    await manager.cancelTask(created.threadId, TASK_PAUSE_CANCEL_REASON);
    await waitForTaskCompletion(manager, created.threadId);

    const types = lifecycleEvents.map((entry) => entry.type);
    expect(types).toEqual(["task-started", "task-progress", "task-canceled"]);

    const canceled = lifecycleEvents.find(
      (entry) => entry.type === "task-canceled",
    );
    expect(canceled?.error).toBe(TASK_PAUSE_CANCEL_REASON);

    // Anything fired by the agent loop after `cancelTask` must NOT have
    // produced another `task-progress` event.
    const progressCount = lifecycleEvents.filter(
      (entry) => entry.type === "task-progress",
    ).length;
    expect(progressCount).toBe(1);
  });
});
