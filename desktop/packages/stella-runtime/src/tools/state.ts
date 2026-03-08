/**
 * State tools: Task, TaskOutput handlers.
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
  if (snapshot.recentActivity && snapshot.recentActivity.length > 0) {
    const activity = snapshot.recentActivity.map((line) => `- ${truncate(line, 300)}`).join("\n");
    return `Task running.\nTask ID: ${snapshot.id}\nElapsed: ${elapsed}ms\n\nRecent activity:\n${activity}${messageSection}`;
  }
  return `Task running.\nTask ID: ${snapshot.id}\nElapsed: ${elapsed}ms${messageSection}`;
};

export const createStateContext = (
  stateRoot: string,
  taskApi?: TaskToolApi,
): StateContext => ({
  stateRoot,
  tasks: new Map(),
  taskApi,
});

export const handleTask = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const action = toOptionalString(args.action)?.toLowerCase();
  const explicitTaskId = toOptionalString(args.task_id ?? args.taskId ?? args.id);
  const contextTaskId = toOptionalString(context.taskId);
  const resolvedTaskId = explicitTaskId ?? contextTaskId;
  const sender: "orchestrator" | "subagent" =
    context.agentType === "orchestrator" ? "orchestrator" : "subagent";
  if ((action === "message" || action === "send") && ctx.taskApi?.sendTaskMessage) {
    const taskId = resolvedTaskId;
    if (!taskId) {
      return { error: "task_id is required for action=message" };
    }
    const message =
      toOptionalString(args.message) ??
      toOptionalString(args.content) ??
      toOptionalString(args.text);
    if (!message) {
      return { error: "message is required for action=message" };
    }
    const delivered = await ctx.taskApi.sendTaskMessage(taskId, message, sender);
    if (!delivered.delivered) {
      return { error: `Task not found: ${taskId}` };
    }
    return {
      result: `Message delivered to task ${taskId}.`,
    };
  }

  if ((action === "inbox" || action === "messages") && ctx.taskApi?.drainTaskMessages) {
    const taskId = resolvedTaskId;
    if (!taskId) {
      return { error: "task_id is required for action=inbox" };
    }
    const recipient: "orchestrator" | "subagent" =
      sender === "orchestrator" ? "orchestrator" : "subagent";
    const messages = await ctx.taskApi.drainTaskMessages(taskId, recipient);
    if (messages.length === 0) {
      return { result: "No new messages." };
    }
    return {
      result: messages.map((entry, index) => `${index + 1}. ${truncate(entry, 1000)}`).join("\n"),
    };
  }

  if ((action === "cancel" || action === "stop") && explicitTaskId) {
    if (ctx.taskApi) {
      const reason = toOptionalString(args.reason);
      const canceled = await ctx.taskApi.cancelTask(explicitTaskId, reason);
      if (!canceled.canceled) {
        return { error: `Task not found: ${explicitTaskId}` };
      }
      return { result: `Task canceled.\nTask ID: ${explicitTaskId}` };
    }
    const localRecord = ctx.tasks.get(explicitTaskId);
    if (!localRecord) return { error: `Task not found: ${explicitTaskId}` };
    localRecord.status = "error";
    localRecord.error = "Canceled";
    localRecord.completedAt = Date.now();
    return { result: `Task canceled.\nTask ID: ${explicitTaskId}` };
  }

  const description = toOptionalString(args.description) ?? "Task";
  const prompt =
    toOptionalString(args.prompt) ??
    toOptionalString(args.command) ??
    description;
  const agentType =
    toOptionalString(args.subagentType ?? args.subagent_type ?? args.agentType) ??
    "general";
  const parentTaskId = toOptionalString(args.parentTaskId ?? args.parent_task_id);
  const threadId = toOptionalString(args.threadId ?? args.thread_id);
  const threadName = toOptionalString(args.threadName ?? args.thread_name);
  const commandId = toOptionalString(args.commandId ?? args.command_id);
  const systemPromptOverride = toOptionalString(
    args.systemPromptOverride ?? args.system_prompt_override,
  );
  const storageMode = context.storageMode ?? "cloud";

  if (ctx.taskApi) {
    const created = await ctx.taskApi.createTask({
      conversationId: context.conversationId,
      description,
      prompt,
      agentType,
      parentTaskId,
      threadId,
      threadName,
      commandId,
      systemPromptOverride,
      storageMode,
    });
    return {
      result: `Task running.\nTask ID: ${created.taskId}\nElapsed: 0ms`,
    };
  }

  // Fallback local in-memory task behavior (used only when no task manager is wired).
  const id = crypto.randomUUID();
  const record: TaskRecord = {
    id,
    description,
    status: "running",
    startedAt: Date.now(),
    completedAt: null,
  };
  ctx.tasks.set(id, record);
  return {
    result: `Task running.\nTask ID: ${id}\nElapsed: 0ms`,
  };
};

export const handleTaskOutput = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolResult> => {
  const taskId = toOptionalString(args.task_id ?? args.taskId ?? args.id);
  if (!taskId) {
    return { error: "task_id is required" };
  }

  if (ctx.taskApi) {
    const snapshot = await ctx.taskApi.getTask(taskId);
    if (!snapshot) {
      return { error: `Task not found: ${taskId}` };
    }
    return { result: formatTaskSnapshot(snapshot) };
  }

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
