import { action, internalAction, mutation, query, ActionCtx } from "./_generated/server";
import { v, ConvexError, Infer } from "convex/values";
import { streamText } from "ai";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { buildSystemPrompt } from "./prompt_builder";
import type { DeviceToolContext } from "./device_tools";
import { createTools } from "./tools";
import { getModelConfig } from "./model";
import { requireConversationOwner } from "./auth";

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

type TaskStatus = "running" | "completed" | "error";

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
  ctx: ActionCtx,
  args: {
    conversationId: Id<"conversations">;
    type: string;
    deviceId: string;
    payload: Record<string, unknown>;
    targetDeviceId: string;
  },
): Promise<void> => {
  await ctx.runMutation(api.events.appendEvent, {
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
};

const executeSubagentRun = async (
  ctx: ActionCtx,
  args: SubagentExecutionArgs,
): Promise<string> => {
  const promptBuild = await buildSystemPrompt(ctx, args.subagentType, {
    ownerId: args.ownerId,
  });
  const pluginTools = (await ctx.runQuery(api.plugins.listToolDescriptors, {})) as PluginToolDescriptor[];

  const toolContext: DeviceToolContext = {
    conversationId: args.conversationId,
    userMessageId: args.userMessageId,
    targetDeviceId: args.targetDeviceId,
    agentType: args.subagentType,
    sourceDeviceId: args.targetDeviceId,
    currentTaskId: args.taskId,
  };

  try {
    const result = await streamText({
      ...getModelConfig(args.subagentType),
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
        },
      ),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: args.prompt.trim() || " " }],
        },
      ],
    });

    const text: string = await result.text;

    await ctx.runMutation(api.tasks.completeTaskRecord, {
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
    const errorMessage = (error as Error).message || "Unknown task error";

    await ctx.runMutation(api.tasks.completeTaskRecord, {
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

export const createTaskRecord = mutation({
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
    await requireConversationOwner(ctx, args.conversationId);
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

export const completeTaskRecord = mutation({
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

export const runSubagent = action({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.string(),
    description: v.string(),
    prompt: v.string(),
    subagentType: v.string(),
    parentTaskId: v.optional(v.id("tasks")),
    runInBackground: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const conversation: Doc<"conversations"> = await requireConversationOwner(ctx, args.conversationId);
    await ctx.runMutation(api.agents.ensureBuiltins, {});

    const promptBuild = await buildSystemPrompt(ctx, args.subagentType, {
      ownerId: conversation.ownerId,
    });

    const created: { taskId: Id<"tasks">; taskDepth: number; maxTaskDepth: number } =
      await ctx.runMutation(api.tasks.createTaskRecord, {
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

    if (args.runInBackground) {
      await ctx.scheduler.runAfter(0, internal.tasks.executeSubagent, {
        conversationId: args.conversationId,
        userMessageId: args.userMessageId,
        targetDeviceId: args.targetDeviceId,
        prompt: args.prompt,
        subagentType: args.subagentType,
        taskId,
        ownerId: conversation.ownerId,
      });

      return `Task running.\nTask ID: ${taskId}\nElapsed: 0ms`;
    }

    return await executeSubagentRun(ctx, {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      prompt: args.prompt,
      subagentType: args.subagentType,
      taskId,
      ownerId: conversation.ownerId,
    });
  },
});

export const executeSubagent = internalAction({
  args: {
    conversationId: v.id("conversations"),
    userMessageId: v.id("events"),
    targetDeviceId: v.string(),
    prompt: v.string(),
    subagentType: v.string(),
    taskId: v.id("tasks"),
    ownerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await executeSubagentRun(ctx, {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      prompt: args.prompt,
      subagentType: args.subagentType,
      taskId: args.taskId,
      ownerId: args.ownerId,
    });
    return null;
  },
});
