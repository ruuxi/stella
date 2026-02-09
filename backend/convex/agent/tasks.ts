import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  ActionCtx,
} from "../_generated/server";
import { v, ConvexError, Infer } from "convex/values";
import { streamText, generateText } from "ai";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { buildSystemPrompt } from "./prompt_builder";
import type { DeviceToolContext } from "./device_tools";
import { createTools } from "../tools/index";
import { resolveModelConfig } from "./model_resolver";
import { requireConversationOwner } from "../auth";

const taskValidator = v.object({
  _id: v.id("tasks"),
  _creationTime: v.number(),
  conversationId: v.id("conversations"),
  parentTaskId: v.optional(v.id("tasks")),
  description: v.string(),
  prompt: v.string(),
  agentType: v.string(),
  status: v.string(),
  taskDepth: v.number(),
  model: v.optional(v.string()),
  result: v.optional(v.string()),
  error: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: v.optional(v.number()),
});

// Task without model field for client responses
const taskClientValidator = v.object({
  _id: v.id("tasks"),
  _creationTime: v.number(),
  conversationId: v.id("conversations"),
  parentTaskId: v.optional(v.id("tasks")),
  description: v.string(),
  prompt: v.string(),
  agentType: v.string(),
  status: v.string(),
  taskDepth: v.number(),
  result: v.optional(v.string()),
  error: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  completedAt: v.optional(v.number()),
});

// Inferred type from validator for type-safe sanitization
type TaskClient = Infer<typeof taskClientValidator>;

const DEFAULT_MAX_TASK_DEPTH = 2;
const SUBAGENT_HISTORY_LIMIT = 100;
const TASK_CANCEL_POLL_INTERVAL_MS = 2000;
const TASK_CHECKIN_INTERVAL_MS = 10 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TaskStatus = "running" | "completed" | "error" | "canceled";

type PluginToolDescriptor = {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Strip model field for client responses */
const toTaskClient = (task: Record<string, unknown>): TaskClient => {
  const { model: _model, ...rest } = task;
  return rest as TaskClient;
};

/** Strip model field, returning null if task is null */
const toTaskClientOrNull = (task: Record<string, unknown> | null): TaskClient | null => {
  if (!task) return null;
  const { model: _model, ...rest } = task;
  return rest as TaskClient;
};

const appendTaskEvent = async (
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    conversationId: Id<"conversations">;
    type: string;
    deviceId: string;
    payload: Record<string, unknown>;
    targetDeviceId: string;
  },
): Promise<void> => {
  await ctx.runMutation(internal.events.appendInternalEvent, {
    conversationId: args.conversationId,
    type: args.type,
    deviceId: args.deviceId,
    targetDeviceId: args.targetDeviceId,
    payload: args.payload,
  });
};

type SubagentExecutionArgs = {
  conversationId: Id<"conversations">;
  userMessageId: Id<"events">;
  targetDeviceId: string;
  prompt: string;
  subagentType: string;
  taskId: Id<"tasks">;
  ownerId?: string;
  includeHistory?: boolean;
  threadId?: Id<"threads">;
};

const buildHistoryMessages = async (
  ctx: ActionCtx,
  conversationId: Id<"conversations">,
  userMessageId: Id<"events">,
  limit: number,
) => {
  const userEvent = await ctx.runQuery(internal.events.getById, { id: userMessageId });
  const historyEvents = await ctx.runQuery(internal.events.listRecentMessages, {
    conversationId,
    limit,
    beforeTimestamp: userEvent?.timestamp,
    excludeEventId: userMessageId,
  });

  return historyEvents.flatMap((event: Doc<"events">) => {
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as { text?: string })
        : {};
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) {
      return [];
    }
    return [
      {
        role: event.type === "assistant_message" ? ("assistant" as const) : ("user" as const),
        content: text,
      },
    ];
  });
};

const executeSubagentRun = async (
  ctx: ActionCtx,
  args: SubagentExecutionArgs,
): Promise<string> => {
  const currentStatus = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
    taskId: args.taskId,
  });
  if (currentStatus && currentStatus !== "running") {
    return `Task ${currentStatus}.\nTask ID: ${args.taskId}`;
  }

  const promptBuild = await buildSystemPrompt(ctx, args.subagentType, {
    ownerId: args.ownerId,
  });
  const pluginTools = (await ctx.runQuery(internal.data.plugins.listToolDescriptorsInternal, {})) as PluginToolDescriptor[];

  // Load thread history if continuing a thread
  let threadMessages: Array<{ role: "user"; content: string } | { role: "assistant"; content: string }> = [];
  let nextStepIndex = 0;
  if (args.threadId) {
    const steps = await ctx.runQuery(internal.data.threads.loadSteps, {
      threadId: args.threadId,
    });
    for (const step of steps) {
      threadMessages.push({ role: "user" as const, content: step.prompt });
      try {
        const parsed = JSON.parse(step.response);
        if (Array.isArray(parsed)) {
          for (const msg of parsed) {
            if (msg.role === "assistant" && typeof msg.content === "string") {
              threadMessages.push({ role: "assistant" as const, content: msg.content });
            } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
              // Extract text parts from structured content
              const textParts = msg.content
                .filter((p: { type: string; text?: string }) => p.type === "text" && p.text)
                .map((p: { text: string }) => p.text)
                .join("");
              if (textParts) {
                threadMessages.push({ role: "assistant" as const, content: textParts });
              }
            }
          }
        }
      } catch {
        // Skip unparseable responses
      }
    }
    nextStepIndex = steps.length;
  }

  // When continuing a thread, skip conversation history — thread has its own context
  const historyMessages = args.threadId
    ? []
    : args.includeHistory
      ? await buildHistoryMessages(
          ctx,
          args.conversationId,
          args.userMessageId,
          SUBAGENT_HISTORY_LIMIT,
        )
      : [];

  const toolContext: DeviceToolContext = {
    conversationId: args.conversationId,
    userMessageId: args.userMessageId,
    targetDeviceId: args.targetDeviceId,
    agentType: args.subagentType,
    sourceDeviceId: args.targetDeviceId,
    currentTaskId: args.taskId,
  };

  let finished = false;
  let canceled = false;
  const abortController = new AbortController();

  const cancelWatcher = (async () => {
    while (!finished) {
      await sleep(TASK_CANCEL_POLL_INTERVAL_MS);
      if (finished) {
        return;
      }
      const status = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
        taskId: args.taskId,
      });
      if (status === "canceled") {
        canceled = true;
        abortController.abort();
        return;
      }
      if (status && status !== "running") {
        return;
      }
    }
  })();

  try {
    const resolvedConfig = await resolveModelConfig(ctx, args.subagentType, args.ownerId);
    const result = await streamText({
      ...resolvedConfig,
      system: promptBuild.systemPrompt,
      tools: createTools(
        ctx,
        toolContext,
        {
          agentType: args.subagentType,
          toolsAllowlist: promptBuild.toolsAllowlist,
          maxTaskDepth: promptBuild.maxTaskDepth,
          pluginTools,
          ownerId: args.ownerId,
          currentTaskId: args.taskId,
          conversationId: args.conversationId,
        },
      ),
      messages: [
        ...threadMessages,
        ...historyMessages,
        {
          role: "user",
          content: [{ type: "text", text: args.prompt.trim() || " " }],
        },
      ],
      abortSignal: abortController.signal,
    });

    const text: string = await result.text;
    finished = true;
    await cancelWatcher;

    // Save thread step if this is a threaded execution
    if (args.threadId) {
      const response = await result.response;
      const responseMessages = response?.messages ?? [];
      await ctx.runMutation(internal.data.threads.appendStep, {
        threadId: args.threadId,
        stepIndex: nextStepIndex,
        prompt: args.prompt,
        response: JSON.stringify(responseMessages),
      });
      await ctx.runMutation(internal.data.threads.touchThread, {
        threadId: args.threadId,
      });
    }

    const postStatus = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
      taskId: args.taskId,
    });
    if (postStatus && postStatus !== "running") {
      return `Task ${postStatus}.\nTask ID: ${args.taskId}`;
    }

    await ctx.runMutation(internal.agent.tasks.completeTaskRecord, {
      taskId: args.taskId,
      status: "completed",
      result: text,
    });

    await appendTaskEvent(ctx, {
      conversationId: args.conversationId,
      type: "task_completed",
      deviceId: args.targetDeviceId,
      targetDeviceId: args.targetDeviceId,
      payload: {
        taskId: args.taskId,
        result: text,
      },
    });

    return `Agent completed.\nTask ID: ${args.taskId}\n\n--- Agent Result ---\n${text}`;
  } catch (error) {
    finished = true;
    await cancelWatcher;

    const status = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
      taskId: args.taskId,
    });
    if (canceled || status === "canceled") {
      return `Task canceled.\nTask ID: ${args.taskId}`;
    }

    const errorMessage = (error as Error).message || "Unknown task error";

    await ctx.runMutation(internal.agent.tasks.completeTaskRecord, {
      taskId: args.taskId,
      status: "error",
      error: errorMessage,
    });

    await appendTaskEvent(ctx, {
      conversationId: args.conversationId,
      type: "task_failed",
      deviceId: args.targetDeviceId,
      targetDeviceId: args.targetDeviceId,
      payload: {
        taskId: args.taskId,
        error: errorMessage,
      },
    });

    return `Task failed.\nTask ID: ${args.taskId}\n\n--- Error ---\n${errorMessage}`;
  }
};

export const createTaskRecord = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.string(),
    description: v.string(),
    prompt: v.string(),
    agentType: v.string(),
    parentTaskId: v.optional(v.id("tasks")),
    maxTaskDepth: v.optional(v.number()),
  },
  returns: v.object({
    taskId: v.id("tasks"),
    taskDepth: v.number(),
    maxTaskDepth: v.number(),
  }),
  handler: async (ctx, args) => {
    const maxTaskDepth = Math.max(1, Math.floor(args.maxTaskDepth ?? DEFAULT_MAX_TASK_DEPTH));

    let taskDepth = 1;
    if (args.parentTaskId) {
      const parent = await ctx.db.get(args.parentTaskId);
      if (parent?.taskDepth) {
        taskDepth = parent.taskDepth + 1;
      }
      if (taskDepth > maxTaskDepth) {
        throw new ConvexError({ code: "LIMIT_EXCEEDED", message: `Task depth limit exceeded (${maxTaskDepth})` });
      }
    }

    const now = Date.now();
    const taskId = await ctx.db.insert("tasks", {
      conversationId: args.conversationId,
      parentTaskId: args.parentTaskId,
      description: args.description,
      prompt: args.prompt,
      agentType: args.agentType,
      status: "running" satisfies TaskStatus,
      taskDepth,
      createdAt: now,
      updatedAt: now,
      completedAt: undefined,
    });

    return { taskId, taskDepth, maxTaskDepth };
  },
});

export const completeTaskRecord = internalMutation({
  args: {
    taskId: v.id("tasks"),
    status: v.string(),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.taskId, {
      status: args.status,
      result: args.result,
      error: args.error,
      updatedAt: now,
      completedAt: now,
    });
    const record = await ctx.db.get(args.taskId);
    return toTaskClientOrNull(record);
  },
});

export const cancelTask = mutation({
  args: {
    taskId: v.id("tasks"),
    reason: v.optional(v.string()),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    if (!record) return null;
    await requireConversationOwner(ctx, record.conversationId);

    if (record.status !== "running") {
      return toTaskClient(record);
    }

    const now = Date.now();
    const reason = args.reason?.trim() || "Canceled";
    await ctx.db.patch(args.taskId, {
      status: "canceled" satisfies TaskStatus,
      error: reason,
      updatedAt: now,
      completedAt: now,
    });

    const targetDeviceId = await ctx.runQuery(internal.events.getLatestDeviceIdForConversation, {
      conversationId: record.conversationId,
    });

    if (targetDeviceId) {
      await appendTaskEvent(ctx, {
        conversationId: record.conversationId,
        type: "task_failed",
        deviceId: targetDeviceId,
        targetDeviceId: targetDeviceId,
        payload: {
          taskId: args.taskId,
          error: reason,
        },
      });
    }

    const updated = await ctx.db.get(args.taskId);
    return toTaskClientOrNull(updated);
  },
});

export const cancelTaskInternal = internalMutation({
  args: {
    taskId: v.id("tasks"),
    reason: v.optional(v.string()),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    if (!record) return null;

    if (record.status !== "running") {
      return toTaskClient(record);
    }

    const now = Date.now();
    const reason = args.reason?.trim() || "Canceled";
    await ctx.db.patch(args.taskId, {
      status: "canceled" satisfies TaskStatus,
      error: reason,
      updatedAt: now,
      completedAt: now,
    });

    const targetDeviceId = await ctx.runQuery(internal.events.getLatestDeviceIdForConversation, {
      conversationId: record.conversationId,
    });

    if (targetDeviceId) {
      await appendTaskEvent(ctx, {
        conversationId: record.conversationId,
        type: "task_failed",
        deviceId: targetDeviceId,
        targetDeviceId: targetDeviceId,
        payload: {
          taskId: args.taskId,
          error: reason,
        },
      });
    }

    const updated = await ctx.db.get(args.taskId);
    return toTaskClientOrNull(updated);
  },
});

export const getTaskStatus = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    return record?.status ?? null;
  },
});

export const getById = query({
  args: {
    taskId: v.id("tasks"),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.taskId);
    if (record) {
      await requireConversationOwner(ctx, record.conversationId);
    }
    return toTaskClientOrNull(record);
  },
});

export const getOutputByExternalId = query({
  args: {
    taskId: v.string(),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    try {
      const record = await ctx.db.get(args.taskId as Id<"tasks">);
      if (record) {
        await requireConversationOwner(ctx, record.conversationId);
      }
      return toTaskClientOrNull(record);
    } catch {
      return null;
    }
  },
});

export const getOutputByExternalIdInternal = internalQuery({
  args: {
    taskId: v.string(),
  },
  returns: v.union(taskClientValidator, v.null()),
  handler: async (ctx, args) => {
    try {
      const record = await ctx.db.get(args.taskId as Id<"tasks">);
      return toTaskClientOrNull(record);
    } catch {
      return null;
    }
  },
});

export const listByConversation = query({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.array(taskClientValidator),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    const records = await ctx.db
      .query("tasks")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(200);
    return records.map((record) => toTaskClient(record));
  },
});

export const listByConversationSince = query({
  args: {
    conversationId: v.id("conversations"),
    afterUpdatedAt: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.array(taskClientValidator),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);

    const afterUpdatedAt = args.afterUpdatedAt ?? 0;
    const requestedLimit = args.limit ?? 200;
    const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), 1000);
    const records = await ctx.db
      .query("tasks")
      .withIndex("by_conversation_updated", (q) =>
        q.eq("conversationId", args.conversationId).gt("updatedAt", afterUpdatedAt),
      )
      .order("asc")
      .take(limit);

    return records.map((record) => toTaskClient(record));
  },
});

export const getConversationTaskHead = query({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.object({
    latestUpdatedAt: v.number(),
    latestTaskId: v.union(v.id("tasks"), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    const latest = await ctx.db
      .query("tasks")
      .withIndex("by_conversation_updated", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .first();

    return {
      latestUpdatedAt: latest?.updatedAt ?? 0,
      latestTaskId: latest?._id ?? null,
    };
  },
});

export const runSubagent = internalAction({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.string(),
    description: v.string(),
    prompt: v.string(),
    subagentType: v.string(),
    parentTaskId: v.optional(v.id("tasks")),
    includeHistory: v.optional(v.boolean()),
    threadId: v.optional(v.id("threads")),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const conversation: Doc<"conversations"> = await requireConversationOwner(ctx, args.conversationId);
    await ctx.runMutation(internal.agent.agents.ensureBuiltins, {});
    await ctx.runMutation(internal.data.skills.ensureBuiltinSkills, {});

    const promptBuild = await buildSystemPrompt(ctx, args.subagentType, {
      ownerId: conversation.ownerId,
    });

    const created: { taskId: Id<"tasks">; taskDepth: number; maxTaskDepth: number } =
      await ctx.runMutation(internal.agent.tasks.createTaskRecord, {
        conversationId: args.conversationId,
        userMessageId: args.userMessageId,
        targetDeviceId: args.targetDeviceId,
        description: args.description,
        prompt: args.prompt,
        agentType: args.subagentType,
        parentTaskId: args.parentTaskId,
        maxTaskDepth: promptBuild.maxTaskDepth,
      });

    const taskId: Id<"tasks"> = created.taskId;
    const taskDepth: number = created.taskDepth;

    await appendTaskEvent(ctx, {
      conversationId: args.conversationId,
      type: "task_started",
      deviceId: args.targetDeviceId,
      targetDeviceId: args.targetDeviceId,
      payload: {
        taskId,
        description: args.description,
        agentType: args.subagentType,
        parentTaskId: args.parentTaskId,
        taskDepth,
        maxTaskDepth: created.maxTaskDepth,
        skillIds: promptBuild.skillIds,
      },
    });

    await ctx.scheduler.runAfter(TASK_CHECKIN_INTERVAL_MS, internal.agent.tasks.taskCheckin, {
      conversationId: args.conversationId,
      targetDeviceId: args.targetDeviceId,
      taskId,
    });

    await ctx.scheduler.runAfter(0, internal.agent.tasks.executeSubagent, {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      description: args.description,
      prompt: args.prompt,
      subagentType: args.subagentType,
      taskId,
      ownerId: conversation.ownerId,
      includeHistory: args.includeHistory,
      threadId: args.threadId,
      parentTaskId: args.parentTaskId,
    });

    return `Task running.\nTask ID: ${taskId}\nElapsed: 0ms`;
  },
});

export const executeSubagent = internalAction({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.string(),
    description: v.string(),
    prompt: v.string(),
    subagentType: v.string(),
    taskId: v.id("tasks"),
    ownerId: v.string(),
    includeHistory: v.optional(v.boolean()),
    threadId: v.optional(v.id("threads")),
    parentTaskId: v.optional(v.id("tasks")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const resultText = await executeSubagentRun(ctx, {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      prompt: args.prompt,
      subagentType: args.subagentType,
      taskId: args.taskId,
      ownerId: args.ownerId,
      includeHistory: args.includeHistory,
      threadId: args.threadId,
    });

    // Deliver result to the orchestrator for top-level tasks only.
    // Nested subagent results flow back through their parent's tool output.
    if (!args.parentTaskId) {
      const task = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
        taskId: args.taskId,
      });
      const status = task === "completed" ? "completed" : task === "error" ? "error" : task ?? "completed";

      // Extract the actual result text from the formatted return string
      const resultMatch = resultText.match(/--- (?:Agent Result|Error) ---\n([\s\S]*)$/);
      const cleanResult = resultMatch?.[1]?.trim() ?? resultText;

      await ctx.scheduler.runAfter(0, internal.agent.tasks.deliverTaskResult, {
        conversationId: args.conversationId,
        userMessageId: args.userMessageId,
        targetDeviceId: args.targetDeviceId,
        taskId: args.taskId,
        description: args.description,
        agentType: args.subagentType,
        result: cleanResult,
        status,
        ownerId: args.ownerId,
      });
    }

    return null;
  },
});

export const taskCheckin = internalAction({
  args: {
    conversationId: v.id("conversations"),
    targetDeviceId: v.string(),
    taskId: v.id("tasks"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const status = await ctx.runQuery(internal.agent.tasks.getTaskStatus, {
      taskId: args.taskId,
    });
    if (!status || status !== "running") {
      return null;
    }

    await appendTaskEvent(ctx, {
      conversationId: args.conversationId,
      type: "task_checkin",
      deviceId: args.targetDeviceId,
      targetDeviceId: args.targetDeviceId,
      payload: {
        taskId: args.taskId,
        status,
      },
    });

    await ctx.scheduler.runAfter(TASK_CHECKIN_INTERVAL_MS, internal.agent.tasks.taskCheckin, {
      conversationId: args.conversationId,
      targetDeviceId: args.targetDeviceId,
      taskId: args.taskId,
    });
    return null;
  },
});

/**
 * Deliver a completed subagent's result to the orchestrator.
 *
 * When a top-level subagent finishes, this action re-invokes the orchestrator
 * with the task result as a user-role message. The orchestrator decides how
 * (or whether) to respond to the user. Its response is saved as an
 * assistant_message event so the frontend picks it up automatically.
 */
export const deliverTaskResult = internalAction({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.string(),
    taskId: v.id("tasks"),
    description: v.string(),
    agentType: v.string(),
    result: v.string(),
    status: v.string(),
    ownerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Build the internal message that the orchestrator will see
    const statusLabel = args.status === "completed" ? "completed" : "failed";
    const deliveryMessage = [
      `[System: Subagent task ${statusLabel}]`,
      `Task ID: ${args.taskId}`,
      `Agent: ${args.agentType}`,
      `Description: ${args.description}`,
      "",
      `--- ${args.status === "completed" ? "Result" : "Error"} ---`,
      args.result,
    ].join("\n");

    // Build orchestrator prompt and tools
    const conversation = await ctx.runQuery(internal.conversations.getById, {
      id: args.conversationId,
    });
    if (!conversation) return null;

    const promptBuild = await buildSystemPrompt(ctx, "orchestrator", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
    });
    const pluginTools = (await ctx.runQuery(
      internal.data.plugins.listToolDescriptorsInternal,
      {},
    )) as PluginToolDescriptor[];

    // Gather recent conversation history so the orchestrator has context
    const historyEvents = await ctx.runQuery(
      internal.events.listRecentMessages,
      {
        conversationId: args.conversationId,
        limit: 20,
      },
    );
    const historyMessages = historyEvents.flatMap((event: Doc<"events">) => {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as { text?: string })
          : {};
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) return [];
      return [
        {
          role:
            event.type === "assistant_message"
              ? ("assistant" as const)
              : ("user" as const),
          content: text,
        },
      ];
    });

    const toolContext: DeviceToolContext = {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      agentType: "orchestrator",
      sourceDeviceId: args.targetDeviceId,
    };

    const resolvedConfig = await resolveModelConfig(
      ctx,
      "orchestrator",
      args.ownerId,
    );

    try {
      const genResult = await generateText({
        ...resolvedConfig,
        system: promptBuild.systemPrompt,
        tools: createTools(ctx, toolContext, {
          agentType: "orchestrator",
          toolsAllowlist: promptBuild.toolsAllowlist,
          maxTaskDepth: promptBuild.maxTaskDepth,
          pluginTools: pluginTools as Array<{
            pluginId: string;
            name: string;
            description: string;
            inputSchema: Record<string, unknown>;
          }>,
          ownerId: args.ownerId,
          conversationId: args.conversationId,
        }),
        messages: [
          ...historyMessages,
          {
            role: "user",
            content: deliveryMessage,
          },
        ],
      });

      const text = genResult.text?.trim() ?? "";
      if (text.length > 0) {
        await ctx.runMutation(internal.events.saveAssistantMessage, {
          conversationId: args.conversationId,
          text,
          userMessageId: args.userMessageId,
          usage: genResult.usage
            ? {
                inputTokens: genResult.usage.inputTokens,
                outputTokens: genResult.usage.outputTokens,
                totalTokens: genResult.usage.totalTokens,
              }
            : undefined,
        });
      }
    } catch (error) {
      console.error("deliverTaskResult failed:", (error as Error).message);
    }

    return null;
  },
});
