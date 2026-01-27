import { tool, ToolSet } from "ai";
import { z } from "zod";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
  createCoreDeviceTools,
  executeDeviceTool,
  type DeviceToolContext,
} from "./device_tools";
import { jsonSchemaToZod } from "./plugins";

export const BASE_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TestWrite",
  "Task",
  "TaskOutput",
  "AskUserQuestion",
  "ImageGenerate",
  "ImageEdit",
  "VideoGenerate",
] as const;

type PluginToolDescriptor = {
  pluginId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ToolOptions = {
  agentType: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  currentTaskId?: Id<"tasks">;
  pluginTools: PluginToolDescriptor[];
};

const filterTools = (
  tools: ToolSet,
  allowlist?: string[],
): ToolSet => {
  if (!allowlist || allowlist.length === 0) {
    return tools;
  }
  const allowed = new Set(allowlist);
  const filteredEntries = Object.entries(tools).filter(([name]) => allowed.has(name));
  return Object.fromEntries(filteredEntries) as ToolSet;
};

const formatTaskResult = (task: {
  _id: Id<"tasks">;
  status: string;
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
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

export const createTools = (
  ctx: ActionCtx,
  context: DeviceToolContext,
  options: ToolOptions,
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
      run_in_background: z.boolean().optional(),
      resume: z.string().optional(),
    }),
    execute: async (args) => {
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
      block: z.boolean().optional(),
      timeout: z.number().optional(),
    }),
    execute: async (args) => {
      try {
        const record = await ctx.runQuery(api.tasks.getOutputByExternalId, {
          taskId: args.task_id,
        });
        if (!record) {
          return `Task not found: ${args.task_id}`;
        }
        return formatTaskResult(record as any);
      } catch {
        return `Failed to load task: ${args.task_id}`;
      }
    },
  });

  const allTools: ToolSet = {
    ...coreTools,
    ...pluginTools,
    Task,
    TaskOutput,
  };

  const allowlist = options.toolsAllowlist
    ? Array.from(
        new Set([
          ...options.toolsAllowlist,
          "Task",
          "TaskOutput",
          ...options.pluginTools.map((toolDef) => toolDef.name),
        ]),
      )
    : undefined;
  return filterTools(allTools, allowlist);
};

export type { DeviceToolContext };
