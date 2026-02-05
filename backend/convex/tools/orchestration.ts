import { tool, ToolSet } from "ai";
import { z } from "zod";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { DeviceToolContext } from "../device_tools";
import { type ToolOptions } from "./types";

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
  if (task.status === "canceled") {
    return `Task canceled.\nTask ID: ${task._id}\nDuration: ${duration}ms\n\n--- Error ---\n${
      task.error ?? "Canceled"
    }`;
  }
  if (task.status === "error") {
    return `Task failed.\nTask ID: ${task._id}\nDuration: ${duration}ms\n\n--- Error ---\n${
      task.error ?? "(no error)"
    }`;
  }
  return `Task running.\nTask ID: ${task._id}\nElapsed: ${duration}ms`;
};

export const createOrchestrationTools = (
  ctx: ActionCtx,
  context: DeviceToolContext,
  options: ToolOptions,
): ToolSet => {
  const Task = tool({
    description:
      "Manage subagent tasks. action: create (delegate a task), output (retrieve result), cancel (stop a running task).",
    inputSchema: z.object({
      action: z.enum(["create", "output", "cancel"]).default("create"),
      // create params
      description: z.string().optional(),
      prompt: z.string().optional(),
      subagent_type: z.string().optional(),
      run_in_background: z.boolean().optional(),
      include_history: z.boolean().optional(),
      resume: z.string().optional(),
      // output/cancel params
      task_id: z.string().optional(),
      reason: z.string().optional(),
    }),
    execute: async (args) => {
      const action = args.action ?? "create";

      if (action === "output") {
        const taskId = args.task_id;
        if (!taskId) return "task_id is required for output action.";
        try {
          const record = await ctx.runQuery(api.tasks.getOutputByExternalId, {
            taskId,
          });
          if (!record) return `Task not found: ${taskId}`;
          return formatTaskResult(record as any);
        } catch {
          return `Failed to load task: ${taskId}`;
        }
      }

      if (action === "cancel") {
        const taskId = args.task_id;
        if (!taskId) return "task_id is required for cancel action.";
        const record = await ctx.runMutation(api.tasks.cancelTask, {
          taskId: taskId as Id<"tasks">,
          reason: args.reason,
        });
        if (!record) return `Task not found: ${taskId}`;
        return formatTaskResult(record as any);
      }

      // action === "create"
      if (!args.description || !args.prompt || !args.subagent_type) {
        return "description, prompt, and subagent_type are required for create action.";
      }
      if (!context.userMessageId) {
        return "Cannot create a task without a user message context.";
      }
      const result = await ctx.runAction(api.tasks.runSubagent, {
        conversationId: context.conversationId,
        userMessageId: context.userMessageId,
        targetDeviceId: context.targetDeviceId,
        description: args.description,
        prompt: args.prompt,
        subagentType: args.subagent_type,
        parentTaskId: options.currentTaskId,
        runInBackground: args.run_in_background,
        includeHistory: args.include_history,
      });

      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  const AgentInvoke = tool({
    description:
      "Invoke a bounded subagent-like tool call and return structured results.",
    inputSchema: z.object({
      agent_type: z.string().min(1),
      mode: z.string().optional(),
      prompt: z.string().optional(),
      input: z.any().optional(),
      result_schema: z.any().optional(),
      max_steps: z.number().int().positive().max(8).optional(),
      target_device_id: z.string().optional(),
    }),
    execute: async (args) => {
      if (args.target_device_id && args.target_device_id !== context.targetDeviceId) {
        return "agent.invoke must target the current device.";
      }
      if (!context.userMessageId) {
        return "AgentInvoke requires a user message context.";
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

  const MemorySearch = tool({
    description:
      "Search episodic memories for relevant past context. Use when the user references past conversations, previous tasks, or you need historical context.",
    inputSchema: z.object({
      query: z.string().min(1).describe("What to search for in memory"),
      category: z.string().optional().describe("Optional category filter"),
    }),
    execute: async (args) => {
      if (!options.ownerId) {
        return "MemorySearch requires an authenticated owner context.";
      }
      try {
        const [categories, results] = await Promise.all([
          ctx.runQuery(internal.memory.listCategories, { ownerId: options.ownerId }),
          ctx.runAction(internal.memory.search, {
            query: args.query,
            category: args.category,
            ownerId: options.ownerId,
          }),
        ]);
        const categoryTree = categories
          .map((c: { category: string; subcategory: string; count: number }) =>
            `${c.category}/${c.subcategory} (${c.count})`,
          )
          .join("\n");
        const memories = results
          .map((r: { category: string; subcategory: string; content: string }) =>
            `[${r.category}/${r.subcategory}] ${r.content}`,
          )
          .join("\n\n");
        return `Available categories:\n${categoryTree}\n\n---\nMatched memories:\n${memories || "(none)"}`;
      } catch (error) {
        return `MemorySearch failed: ${(error as Error).message}`;
      }
    },
  });

  return {
    Task,
    AgentInvoke,
    MemorySearch,
  };
};
