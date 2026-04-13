/**
 * State tools: TaskCreate/TaskPause, TaskUpdate, and TaskOutput handlers.
 */

import type {
  ToolContext,
  ToolResult,
  TaskRecord,
  TaskToolApi,
  TaskToolSnapshot,
} from "./types.js";
import {
  formatRuntimeThreadAge,
  type RuntimeThreadRecord,
} from "../runtime-threads.js";
import { truncate } from "./utils.js";
import { AGENT_IDS } from "../../../src/shared/contracts/agent-runtime.js";

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

const buildOtherThreadsResult = (
  threads: Array<Pick<RuntimeThreadRecord, "threadId" | "description" | "lastUsedAt">>,
  currentThreadId: string,
) =>
  threads
    .filter((thread) => thread.threadId !== currentThreadId)
    .map((thread) => ({
      thread_id: thread.threadId,
      availability: "resumable",
      last_used: formatRuntimeThreadAge(thread.lastUsedAt),
      ...(thread.description ? { description: thread.description } : {}),
    }));

const buildTaskSnapshotResult = (snapshot: TaskToolSnapshot) => {
  const duration = (snapshot.completedAt ?? Date.now()) - snapshot.startedAt;
  const messages = snapshot.messages?.map((entry) => ({
    from: entry.from,
    text: truncate(entry.text, 240),
    timestamp: entry.timestamp,
  }));
  if (snapshot.status === "completed") {
    return {
      thread_id: snapshot.id,
      status: snapshot.status,
      description: snapshot.description,
      duration_ms: duration,
      result: truncate(snapshot.result ?? ""),
      ...(messages && messages.length > 0 ? { messages } : {}),
    };
  }
  if (snapshot.status === "error" || snapshot.status === "canceled") {
    return {
      thread_id: snapshot.id,
      status: snapshot.status,
      description: snapshot.description,
      duration_ms: duration,
      error: truncate(snapshot.error ?? ""),
      ...(messages && messages.length > 0 ? { messages } : {}),
    };
  }
  const elapsed = Date.now() - snapshot.startedAt;
  return {
    thread_id: snapshot.id,
    status: snapshot.status,
    description: snapshot.description,
    elapsed_ms: elapsed,
    background: true,
    follow_up_on_completion: true,
    ...(snapshot.recentActivity && snapshot.recentActivity.length > 0
      ? {
          recent_activity: snapshot.recentActivity.map((line) =>
            truncate(line, 300),
          ),
        }
      : {}),
    ...(messages && messages.length > 0 ? { messages } : {}),
  };
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
    result: {
      thread_id: threadId,
      status: "updated",
      delivered: true,
    },
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
      return {
        result: {
          thread_id: explicitThreadId,
          status: "canceled",
          canceled: true,
        },
      };
    }
    const localRecord = ctx.tasks.get(explicitThreadId);
    if (!localRecord) return { error: `Thread not found: ${explicitThreadId}` };
    localRecord.status = "error";
    localRecord.error = "Canceled";
    localRecord.completedAt = Date.now();
    return {
      result: {
        thread_id: explicitThreadId,
        status: "canceled",
        canceled: true,
      },
    };
  }

  const agentType = AGENT_IDS.GENERAL;
  const parentTaskId =
    toOptionalString(args.parentTaskId ?? args.parent_task_id) ??
    toOptionalString(context.cloudTaskId) ??
    toOptionalString(context.taskId);
  const storageMode = context.storageMode ?? "local";
  const parentTaskDepth = Math.max(0, context.taskDepth ?? 0);
  const nextTaskDepth = parentTaskDepth + 1;
  const maxTaskDepth = context.maxTaskDepth;

  if (context.agentType !== AGENT_IDS.ORCHESTRATOR) {
    return {
      error: "Only the orchestrator can create tasks.",
    };
  }

  if (typeof maxTaskDepth === "number" && nextTaskDepth > maxTaskDepth) {
    return {
      error: `Task depth limit reached (${maxTaskDepth}). Complete work in the current task instead of creating another subtask.`,
    };
  }

  const description = toOptionalString(args.description);
  if (!description) {
    return { error: "description is required" };
  }
  const prompt = toOptionalString(args.prompt);
  if (!prompt) {
    return { error: "prompt is required" };
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
      storageMode,
    });
    const otherThreads = created.activeThreads
      ? buildOtherThreadsResult(created.activeThreads, created.threadId)
      : [];
    return {
      result: {
        thread_id: created.threadId,
        created: true,
        running_in_background: true,
        follow_up_on_completion: true,
        ...(otherThreads.length > 0 ? { other_threads: otherThreads } : {}),
      },
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
  const activeThreads = [...ctx.tasks.values()].slice(-16).map((task) => ({
    threadId: task.id,
    description: task.description,
    lastUsedAt: task.completedAt ?? task.startedAt,
  }));
  const otherThreads = buildOtherThreadsResult(activeThreads, id);
  return {
    result: {
      thread_id: id,
      created: true,
      running_in_background: true,
      follow_up_on_completion: true,
      ...(otherThreads.length > 0 ? { other_threads: otherThreads } : {}),
    },
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
    return { result: buildTaskSnapshotResult(snapshot) };
  }

  const record = ctx.tasks.get(threadId);
  if (!record) {
    return { error: `Thread not found: ${threadId}` };
  }
  if (record.status === "completed") {
    const duration = (record.completedAt ?? Date.now()) - record.startedAt;
    return {
      result: {
        thread_id: threadId,
        status: "completed",
        duration_ms: duration,
        result: truncate(record.result ?? ""),
      },
    };
  }
  if (record.status === "error") {
    const duration = (record.completedAt ?? Date.now()) - record.startedAt;
    return {
      result: {
        thread_id: threadId,
        status: "error",
        duration_ms: duration,
        error: truncate(record.error ?? ""),
      },
    };
  }
  const elapsed = Date.now() - record.startedAt;
  return {
    result: {
      thread_id: threadId,
      status: "running",
      background: true,
      elapsed_ms: elapsed,
      follow_up_on_completion: true,
    },
  };
};
