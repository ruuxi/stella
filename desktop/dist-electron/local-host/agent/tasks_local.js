/**
 * Local task execution — runs subagent tasks in-process.
 * Replaces Convex's ctx.scheduler.runAfter() with setImmediate().
 * Ported from backend/convex/agent/tasks.ts (simplified for local mode).
 */
import { insert, update, findById, rawQuery } from "../db";
import { broadcastSSE } from "../server";
const log = (...args) => console.log("[local-tasks]", ...args);
// Active tasks for cancellation
const activeTasks = new Map();
// Callback for when a task completes (set by the runtime)
let taskCompletionCallback = null;
export function setTaskCompletionCallback(cb) {
    taskCompletionCallback = cb;
}
// ─── Task CRUD ───────────────────────────────────────────────────────────────
export function createTask(params) {
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
export function updateTaskStatus(taskId, status, data) {
    const now = Date.now();
    const updates = {
        status,
        updated_at: now,
    };
    if (status === "completed" || status === "failed" || status === "cancelled") {
        updates.completed_at = now;
    }
    if (data?.result !== undefined)
        updates.result = data.result;
    if (data?.error !== undefined)
        updates.error = data.error;
    update("tasks", updates, { id: taskId });
    const task = findById("tasks", taskId);
    if (!task)
        return;
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
export function addTaskStatusUpdate(taskId, text) {
    const task = findById("tasks", taskId);
    if (!task)
        return;
    const updates = typeof task.status_updates === "string"
        ? JSON.parse(task.status_updates)
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
export function cancelTask(taskId) {
    const controller = activeTasks.get(taskId);
    if (controller) {
        controller.abort();
        activeTasks.delete(taskId);
    }
    updateTaskStatus(taskId, "cancelled");
    return true;
}
export function getTaskAbortController(taskId) {
    let controller = activeTasks.get(taskId);
    if (!controller) {
        controller = new AbortController();
        activeTasks.set(taskId, controller);
    }
    return controller;
}
export function removeTaskController(taskId) {
    activeTasks.delete(taskId);
}
export function getTaskById(taskId) {
    return findById("tasks", taskId);
}
export function listConversationTasks(conversationId) {
    return rawQuery("SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 50", [conversationId]);
}
