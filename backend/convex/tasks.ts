import { action, mutation, query, ActionCtx } from "./_generated/server";
import { v, ConvexError, Infer } from "convex/values";
import { streamText, tool, ToolSet } from "ai";
import { z } from "zod";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildSystemPrompt } from "./prompt_builder";
import {
  createCoreDeviceTools,
  executeDeviceTool,
  type DeviceToolContext,
} from "./device_tools";
import { jsonSchemaToZod } from "./plugins";
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

const formatTaskResult = (task: {
  _id: Id<"tasks">;
  status: string;
  result?: string;
  error?: string;
  taskDepth: number;
  completedAt?: number;
  createdAt: number;
}) => {
  const duration = (task.completedAt ?? Date.now()) - task.createdAt;
  if (task.status === "completed") {
    return `Task completed.\nTask ID: ${task._id}\nDuration: ${duration}ms\n\n--- Result ---\n${
      task.result ?? "(no result)"
    }`;
  }
  if (task.status === "error") {
    return `Task failed.\nTask ID: ${task._id}\nDuration: ${duration}ms\n\n--- Error ---\n${
      task.error ?? "(no error)"
    }`;
  }
  return `Task running.\nTask ID: ${task._id}\nElapsed: ${duration}ms`;
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

const createTaskTools = (
  ctx: ActionCtx,
  context: DeviceToolContext,
  options: {
    currentTaskId: Id<"tasks">;
    taskDepth: number;
    maxTaskDepth: number;
    pluginTools: PluginToolDescriptor[];
  },
): ToolSet => {
  const coreTools = createCoreDeviceTools(ctx, context);

  const pluginToolEntries = options.pluginTools.map((descriptor) => {
    return [
      descriptor.name,
      tool({
        description: descriptor.description,
        inputSchema: jsonSchemaToZod(descriptor.inputSchema),
        execute: (args) => executeDeviceTool(ctx, context, descriptor.name, args),
      }),
    ] as const;
  });

  const pluginTools = Object.fromEntries(pluginToolEntries);

  const Task = tool({
    description: "Delegate a task to a specialized subagent.",
    inputSchema: z.object({
      description: z.string().min(1),
      prompt: z.string().min(1),
      subagent_type: z.string().min(1),
    }),
    execute: async (args) => {
      if (options.taskDepth >= options.maxTaskDepth) {
        return `Task depth limit reached (${options.maxTaskDepth}). Complete the work directly.`;
      }

      const result = await ctx.runAction(api.tasks.runSubagent, {
        conversationId: context.conversationId,
        userMessageId: context.userMessageId,
        targetDeviceId: context.targetDeviceId,
        description: args.description,
        prompt: args.prompt,
        subagentType: args.subagent_type,
        parentTaskId: options.currentTaskId,
      });

      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  const TaskOutput = tool({
    description: "Retrieve output from a background task.",
    inputSchema: z.object({
      task_id: z.string().min(1),
    }),
    execute: async (args) => {
      try {
        const result = await ctx.runQuery(api.tasks.getOutputByExternalId, {
          taskId: args.task_id,
        });
        if (!result) {
          return `Task not found: ${args.task_id}`;
        }
        return formatTaskResult(result as any);
      } catch {
        return `Failed to load task: ${args.task_id}`;
      }
    },
  });

  const AgentInvoke = tool({
    description:
      "Invoke a bounded tool-like subagent call and return structured results.",
    inputSchema: z.object({
      agent_type: z.string().min(1),
      mode: z.string().optional(),
      prompt: z.string().optional(),
      input: z.any().optional(),
      result_schema: z.any().optional(),
      max_steps: z.number().int().positive().max(6).optional(),
      target_device_id: z.string().optional(),
    }),
    execute: async (args) => {
      if (args.target_device_id && args.target_device_id !== context.targetDeviceId) {
        return "agent.invoke must target the current device.";
      }

      const result = await ctx.runAction(api.agent.invoke, {
        agentType: args.agent_type,
        mode: args.mode,
        prompt: args.prompt,
        input: args.input,
        resultSchema: args.result_schema,
        maxSteps: args.max_steps,
        conversationId: context.conversationId,
        userMessageId: context.userMessageId,
        targetDeviceId: context.targetDeviceId,
      });

      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  return {
    ...coreTools,
    ...pluginTools,
    Task,
    TaskOutput,
    AgentInvoke,
  };
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
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    await ctx.runMutation(api.agents.ensureBuiltins, {});

    const promptBuild = await buildSystemPrompt(ctx, args.subagentType);

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

    const pluginTools = (await ctx.runQuery(api.plugins.listToolDescriptors, {})) as PluginToolDescriptor[];

    const toolContext: DeviceToolContext = {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      agentType: args.subagentType,
      sourceDeviceId: args.targetDeviceId,
      currentTaskId: taskId,
    };

    try {
      const result = await streamText({
        ...getModelConfig(args.subagentType),
        system: promptBuild.systemPrompt,
        tools: createTaskTools(ctx, toolContext, {
          currentTaskId: taskId,
          taskDepth,
          maxTaskDepth: promptBuild.maxTaskDepth,
          pluginTools,
        }),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: args.prompt.trim() || " " }],
          },
        ],
      });

      const text: string = await result.text;

      await ctx.runMutation(api.tasks.completeTaskRecord, {
        taskId,
        status: "completed",
        result: text,
      });

      await appendTaskEvent(ctx, {
        conversationId: args.conversationId,
        type: "task_completed",
        deviceId: args.targetDeviceId,
        targetDeviceId: args.targetDeviceId,
        payload: {
          taskId,
          result: text,
        },
      });

      return `Agent completed.\nTask ID: ${taskId}\n\n--- Agent Result ---\n${text}`;
    } catch (error) {
      const errorMessage = (error as Error).message || "Unknown task error";

      await ctx.runMutation(api.tasks.completeTaskRecord, {
        taskId,
        status: "error",
        error: errorMessage,
      });

      await appendTaskEvent(ctx, {
        conversationId: args.conversationId,
        type: "task_failed",
        deviceId: args.targetDeviceId,
        targetDeviceId: args.targetDeviceId,
        payload: {
          taskId,
          error: errorMessage,
        },
      });

      return `Task failed.\nTask ID: ${taskId}\n\n--- Error ---\n${errorMessage}`;
    }
  },
});
