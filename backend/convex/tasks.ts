import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { streamText, tool } from "ai";
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

const appendTaskEvent = async (
  ctx: any,
  args: {
    conversationId: Id<"conversations">;
    type: string;
    deviceId: string;
    payload: Record<string, unknown>;
    targetDeviceId: string;
  },
) => {
  await ctx.runMutation(api.events.appendEvent, {
    conversationId: args.conversationId,
    type: args.type,
    deviceId: args.deviceId,
    targetDeviceId: args.targetDeviceId,
    payload: args.payload,
  });
};

const createTaskTools = (
  ctx: any,
  context: DeviceToolContext,
  options: {
    currentTaskId: Id<"tasks">;
    taskDepth: number;
    maxTaskDepth: number;
    pluginTools: PluginToolDescriptor[];
  },
) => {
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
      model: z.string().optional(),
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
        model: args.model,
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

  return {
    ...coreTools,
    ...pluginTools,
    Task,
    TaskOutput,
  } as Record<string, ReturnType<typeof tool>>;
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
    model: v.optional(v.string()),
    maxTaskDepth: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const maxTaskDepth = Math.max(1, Math.floor(args.maxTaskDepth ?? DEFAULT_MAX_TASK_DEPTH));

    let taskDepth = 1;
    if (args.parentTaskId) {
      const parent = await ctx.db.get(args.parentTaskId);
      if (parent?.taskDepth) {
        taskDepth = parent.taskDepth + 1;
      }
      if (taskDepth > maxTaskDepth) {
        throw new Error(`Task depth limit exceeded (${maxTaskDepth}).`);
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
      model: args.model,
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
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.taskId, {
      status: args.status,
      result: args.result,
      error: args.error,
      updatedAt: now,
      completedAt: now,
    });
    return await ctx.db.get(args.taskId);
  },
});

export const getById = query({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.taskId);
  },
});

export const getOutputByExternalId = query({
  args: {
    taskId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      return await ctx.db.get(args.taskId as Id<"tasks">);
    } catch {
      return null;
    }
  },
});

export const listByConversation = query({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(200);
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
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(api.agents.ensureBuiltins, {});

    const promptBuild = await buildSystemPrompt(ctx, args.subagentType);

    const created = await ctx.runMutation(api.tasks.createTaskRecord, {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      description: args.description,
      prompt: args.prompt,
      agentType: args.subagentType,
      parentTaskId: args.parentTaskId,
      model: args.model,
      maxTaskDepth: promptBuild.maxTaskDepth,
    });

    const taskId = created.taskId as Id<"tasks">;
    const taskDepth = created.taskDepth;

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

    const model = process.env.AI_GATEWAY_MODEL;
    if (!model) {
      const errorMessage = "AI gateway model not configured";
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
      return `Task failed.\nTask ID: ${taskId}\n\n${errorMessage}`;
    }

    const pluginTools = (await ctx.runQuery(api.plugins.listToolDescriptors, {})) as PluginToolDescriptor[];

    const toolContext: DeviceToolContext = {
      conversationId: args.conversationId,
      userMessageId: args.userMessageId,
      targetDeviceId: args.targetDeviceId,
      sourceDeviceId: args.targetDeviceId,
      currentTaskId: taskId,
    };

    try {
      const result = await streamText({
        model,
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

      const text = await result.text;

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
