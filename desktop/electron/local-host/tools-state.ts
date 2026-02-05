/**
 * State tools: Task, TaskOutput handlers.
 */

import type { ToolResult, TaskRecord } from "./tools-types.js";
import { truncate } from "./tools-utils.js";

export type StateContext = {
  stateRoot: string;
  tasks: Map<string, TaskRecord>;
};

export const createStateContext = (stateRoot: string): StateContext => ({
  stateRoot,
  tasks: new Map(),
});

export const handleTask = async (
  ctx: StateContext,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const description = String(args.description ?? "Task");
  const id = crypto.randomUUID();
  const record: TaskRecord = {
    id,
    description,
    status: "completed",
    result:
      "Task delegation is handled server-side. This device should not receive Task requests.",
    startedAt: Date.now(),
    completedAt: Date.now(),
  };
  ctx.tasks.set(id, record);
  return {
    result: `Agent completed.\nTask ID: ${id}\n\n--- Agent Result ---\n${record.result}`,
  };
};

export const handleTaskOutput = async (
  ctx: StateContext,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const taskId = String(args.task_id ?? "");
  const record = ctx.tasks.get(taskId);
  if (!record) {
    return { error: `Task not found: ${taskId}` };
  }
  if (record.status === "completed") {
    const duration = (record.completedAt ?? Date.now()) - record.startedAt;
    return {
      result: `Task completed.\nDuration: ${duration}ms\n\n--- Result ---\n${truncate(record.result ?? "")}`,
    };
  }
  if (record.status === "error") {
    const duration = (record.completedAt ?? Date.now()) - record.startedAt;
    return {
      result: `Task failed.\nDuration: ${duration}ms\n\n--- Error ---\n${truncate(record.error ?? "")}`,
    };
  }
  const elapsed = Date.now() - record.startedAt;
  return {
    result: `Task still running.\nTask ID: ${taskId}\nElapsed: ${elapsed}ms`,
  };
};
