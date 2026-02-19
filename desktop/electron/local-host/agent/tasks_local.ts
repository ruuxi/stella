/**
 * Local task execution — runs subagent tasks in-process.
 * Replaces Convex's ctx.scheduler.runAfter() with setImmediate().
 * Ported from backend/convex/agent/tasks.ts (simplified for local mode).
 */

import { newId, insert, update, findById, rawQuery } from "../db.js";
import { broadcastSSE } from "../server.js";

const log = (...args: unknown[]) => console.log("[local-tasks]", ...args);

// ─── Types ───────────────────────────────────────────────────────────────────

export type TaskRow = {
  id: string;
  conversation_id: string;
  parent_task_id?: string;
  description: string;
  prompt: string;
  agent_type: string;
  status: string;
  task_depth: number;
  model?: string;
  command_id?: string;
  result?: string;
  error?: string;
  status_updates?: string;
  created_at: number;
  updated_at: number;
  completed_at?: number;
};

export type TaskCreateParams = {
  conversationId: string;
  parentTaskId?: string;
  description: string;
  prompt: string;
  agentType: string;
  taskDepth?: number;
  model?: string;
  commandId?: string;
};

// Active tasks for cancellation
const activeTasks = new Map<string, AbortController>();

// Callback for when a task completes (set by the runtime)
let taskCompletionCallback: ((task: TaskRow) => void) | null = null;

export function setTaskCompletionCallback(cb: (task: TaskRow) => void): void {
  taskCompletionCallback = cb;
}

// ─── Task CRUD ───────────────────────────────────────────────────────────────

export function createTask(params: TaskCreateParams): string {
  const now = Date.now();
  const id = insert("tasks", {
    conversation_id: params.conversationId,
    parent_task_id: params.parentTaskId || null,
    description: params.description,
    prompt: params.prompt,
    agent_type: params.agentType,
    status: "pending",
    task_depth: params.taskDepth || 0,
    model: params.model || null,
    command_id: params.commandId || null,
    created_at: now,
    updated_at: now,
  });

  // Emit task_started event
  insert("events", {
    conversation_id: params.conversationId,
    timestamp: now,
    type: "task_started",
    payload: JSON.stringify({
      taskId: id,
      description: params.description,
      agentType: params.agentType,
    }),
  });

  broadcastSSE(params.conversationId, "task_updated", {
    id,
    status: "pending",
    description: params.description,
    agent_type: params.agentType,
  });

  return id;
}

export function updateTaskStatus(
  taskId: string,
  status: string,
  data?: { result?: string; error?: string },
): void {
  const now = Date.now();
  const updates: Record<string, unknown> = {
    status,
    updated_at: now,
  };

  if (status === "completed" || status === "failed" || status === "cancelled") {
    updates.completed_at = now;
  }
  if (data?.result !== undefined) updates.result = data.result;
  if (data?.error !== undefined) updates.error = data.error;

  update("tasks", updates, { id: taskId });

  const task = findById<TaskRow>("tasks", taskId);
  if (!task) return;

  // Emit event
  const eventType = status === "completed" ? "task_completed"
    : status === "failed" ? "task_failed"
    : undefined;

  if (eventType) {
    insert("events", {
      conversation_id: task.conversation_id,
      timestamp: now,
      type: eventType,
      payload: JSON.stringify({
        taskId,
        result: data?.result,
        error: data?.error,
      }),
    });
  }

  broadcastSSE(task.conversation_id, "task_updated", task);

  // Deliver completion to parent if top-level task
  if ((status === "completed" || status === "failed") && !task.parent_task_id && taskCompletionCallback) {
    taskCompletionCallback(task);
  }
}

export function addTaskStatusUpdate(taskId: string, text: string): void {
  const task = findById<TaskRow>("tasks", taskId);
  if (!task) return;

  const updates = typeof task.status_updates === "string"
    ? JSON.parse(task.status_updates) as Array<{ text: string; timestamp: number }>
    : [];
  updates.push({ text, timestamp: Date.now() });

  update("tasks", {
    status_updates: JSON.stringify(updates),
    updated_at: Date.now(),
  }, { id: taskId });

  broadcastSSE(task.conversation_id, "task_updated", {
    ...task,
    status_updates: updates,
  });
}

export function cancelTask(taskId: string): boolean {
  const controller = activeTasks.get(taskId);
  if (controller) {
    controller.abort();
    activeTasks.delete(taskId);
  }
  updateTaskStatus(taskId, "cancelled");
  return true;
}

export function getTaskAbortController(taskId: string): AbortController {
  let controller = activeTasks.get(taskId);
  if (!controller) {
    controller = new AbortController();
    activeTasks.set(taskId, controller);
  }
  return controller;
}

export function removeTaskController(taskId: string): void {
  activeTasks.delete(taskId);
}

export function getTaskById(taskId: string): TaskRow | undefined {
  return findById<TaskRow>("tasks", taskId);
}

export function listConversationTasks(conversationId: string): TaskRow[] {
  return rawQuery<TaskRow>(
    "SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 50",
    [conversationId],
  );
}
