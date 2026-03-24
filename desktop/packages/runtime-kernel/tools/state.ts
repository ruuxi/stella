/**
 * State tools: TaskCreate/TaskCancel, TaskUpdate, and TaskOutput handlers.
 */

import type {
  ToolContext,
  ToolResult,
  TaskRecord,
  TaskToolApi,
  TaskToolSnapshot,
} from "./types.js";
import { truncate } from "./utils.js";

export type StateContext = {
  stateRoot: string;
  tasks: Map<string, TaskRecord>;
  taskApi?: TaskToolApi;
};

const toOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const formatTaskSnapshot = (snapshot: TaskToolSnapshot): string => {
  const duration = (snapshot.completedAt ?? Date.now()) - snapshot.startedAt;
  const messageSection =
    snapshot.messages && snapshot.messages.length > 0
      ? `\n\nMessages:\n${snapshot.messages
          .map((entry) => `- [${entry.from}] ${truncate(entry.text, 240)}`)
          .join("\n")}`
      : "";
  if (snapshot.status === "completed") {
    return `Task completed.\nDuration: ${duration}ms\n\n--- Result ---\n${truncate(snapshot.result ?? "")}${messageSection}`;
  }
  if (snapshot.status === "error" || snapshot.status === "canceled") {
    const label = snapshot.status === "canceled" ? "Task canceled." : "Task failed.";
    return `${label}\nDuration: ${duration}ms\n\n--- Error ---\n${truncate(snapshot.error ?? "")}${messageSection}`;
  }
  const elapsed = Date.now() - snapshot.startedAt;
  const runningHeader =
    "Task is running in the background.\n" +
    `Thread ID: ${snapshot.id}\n` +
    `Elapsed: ${elapsed}ms\n` +
    "You will receive a follow-up message when it completes or fails.";
  if (snapshot.recentActivity && snapshot.recentActivity.length > 0) {
    const activity = snapshot.recentActivity.map((line) => `- ${truncate(line, 300)}`).join("\n");
    return `${runningHeader}\n\nRecent activity:\n${activity}${messageSection}`;
  }
  return `${runningHeader}${messageSection}`;
};

export const createStateContext = (
  stateRoot: string,
  taskApi?: TaskToolApi,
): StateContext => ({
  stateRoot,
  tasks: new Map(),
  taskApi,
});

export const handleTaskUpdate = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const explicitThreadId = toOptionalString(args.thread_id ?? args.threadId ?? args.id);
  const contextThreadId = toOptionalString(context.taskId);
  const threadId = explicitThreadId ?? contextThreadId;
  const sender: "orchestrator" | "subagent" =
    context.agentType === "orchestrator" ? "orchestrator" : "subagent";
  if (!ctx.taskApi?.sendTaskMessage) {
    return { error: "Task updates are not configured on this device." };
  }
  if (!threadId) {
    return { error: "thread_id is required" };
  }
  const message =
    toOptionalString(args.message) ??
    toOptionalString(args.content) ??
    toOptionalString(args.text);
  if (!message) {
    return { error: "message is required" };
  }
  const delivered = await ctx.taskApi.sendTaskMessage(threadId, message, sender);
  if (!delivered.delivered) {
    return { error: `Thread not found: ${threadId}` };
  }
  return {
    result: `Task update delivered to ${threadId}.`,
  };
};

export const handleTask = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const action = toOptionalString(args.action)?.toLowerCase();
  const explicitThreadId = toOptionalString(args.thread_id ?? args.threadId ?? args.id);

  if ((action === "cancel" || action === "stop") && explicitThreadId) {
    if (ctx.taskApi) {
      const reason = toOptionalString(args.reason);
      const canceled = await ctx.taskApi.cancelTask(explicitThreadId, reason);
      if (!canceled.canceled) {
        return { error: `Thread not found: ${explicitThreadId}` };
      }
      return { result: `Task canceled.\nThread ID: ${explicitThreadId}` };
    }
    const localRecord = ctx.tasks.get(explicitThreadId);
    if (!localRecord) return { error: `Thread not found: ${explicitThreadId}` };
    localRecord.status = "error";
    localRecord.error = "Canceled";
    localRecord.completedAt = Date.now();
    return { result: `Task canceled.\nThread ID: ${explicitThreadId}` };
  }

  const description = toOptionalString(args.description) ?? "Task";
  const prompt =
    toOptionalString(args.prompt) ??
    toOptionalString(args.command) ??
    description;
  const agentType =
    toOptionalString(args.subagentType ?? args.subagent_type ?? args.agentType) ??
    "general";
  const delegationAllowlist = context.delegationAllowlist ?? [];
  const parentTaskId =
    toOptionalString(args.parentTaskId ?? args.parent_task_id) ??
    toOptionalString(context.cloudTaskId) ??
    toOptionalString(context.taskId);
  const systemPromptOverride = toOptionalString(
    args.systemPromptOverride ?? args.system_prompt_override,
  );
  const storageMode = context.storageMode ?? "local";
  const parentTaskDepth = Math.max(0, context.taskDepth ?? 0);
  const nextTaskDepth = parentTaskDepth + 1;
  const maxTaskDepth = context.maxTaskDepth;

  if (delegationAllowlist.length === 0) {
    return {
      error: "This agent cannot create subtasks.",
    };
  }

  if (!delegationAllowlist.includes(agentType)) {
    return {
      error: `This agent can only create these subtask types: ${delegationAllowlist.join(", ")}.`,
    };
  }

  if (typeof maxTaskDepth === "number" && nextTaskDepth > maxTaskDepth) {
    return {
      error: `Task depth limit reached (${maxTaskDepth}). Complete work in the current task instead of creating another subtask.`,
    };
  }

  if (ctx.taskApi) {
    const created = await ctx.taskApi.createTask({
      conversationId: context.conversationId,
      description,
      prompt,
      agentType,
      rootRunId: context.rootRunId,
      taskDepth: nextTaskDepth,
      ...(typeof maxTaskDepth === "number" ? { maxTaskDepth } : {}),
      parentTaskId,
      systemPromptOverride,
      storageMode,
    });
    return {
      result: [
        "Task is now running in the background.",
        `Thread ID: ${created.threadId}`,
        "Elapsed: 0ms",
        "You will receive a follow-up message when it completes or fails.",
        "Do not create another task for the same work. You may gently respond to the user or call NoResponse.",
      ].join("\n"),
    };
  }

  // Fallback local in-memory task behavior (used only when no task manager is wired).
  const id = String(ctx.tasks.size + 1);
  const record: TaskRecord = {
    id,
    description,
    status: "running",
    startedAt: Date.now(),
    completedAt: null,
  };
  ctx.tasks.set(id, record);
  return {
    result: [
      "Task is now running in the background.",
      `Thread ID: ${id}`,
      "Elapsed: 0ms",
      "You will receive a follow-up message when it completes or fails.",
      "Do not create another task for the same work. You may gently respond to the user or call NoResponse.",
    ].join("\n"),
  };
};

export const handleTaskOutput = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolResult> => {
  const threadId = toOptionalString(args.thread_id ?? args.threadId ?? args.id);
  if (!threadId) {
    return { error: "thread_id is required" };
  }

  if (ctx.taskApi) {
    const snapshot = await ctx.taskApi.getTask(threadId);
    if (!snapshot) {
      return { error: `Thread not found: ${threadId}` };
    }
    return { result: formatTaskSnapshot(snapshot) };
  }

  const record = ctx.tasks.get(threadId);
  if (!record) {
    return { error: `Thread not found: ${threadId}` };
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
    result: [
      "Task is running in the background.",
      `Thread ID: ${threadId}`,
      `Elapsed: ${elapsed}ms`,
      "You will receive a follow-up message when it completes or fails.",
    ].join("\n"),
  };
};
