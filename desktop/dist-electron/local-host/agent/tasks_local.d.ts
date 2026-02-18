/**
 * Local task execution — runs subagent tasks in-process.
 * Replaces Convex's ctx.scheduler.runAfter() with setImmediate().
 * Ported from backend/convex/agent/tasks.ts (simplified for local mode).
 */
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
export declare function setTaskCompletionCallback(cb: (task: TaskRow) => void): void;
export declare function createTask(params: TaskCreateParams): string;
export declare function updateTaskStatus(taskId: string, status: string, data?: {
    result?: string;
    error?: string;
}): void;
export declare function addTaskStatusUpdate(taskId: string, text: string): void;
export declare function cancelTask(taskId: string): boolean;
export declare function getTaskAbortController(taskId: string): AbortController;
export declare function removeTaskController(taskId: string): void;
export declare function getTaskById(taskId: string): TaskRow | undefined;
export declare function listConversationTasks(conversationId: string): TaskRow[];
