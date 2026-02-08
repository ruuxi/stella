import { tool, ToolSet } from "ai";
import { z } from "zod";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { DeviceToolContext } from "../agent/device_tools";
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
  const TaskCreate = tool({
    description: "Delegate a task to a subagent.",
    inputSchema: z.object({
      description: z.string(),
      prompt: z.string(),
      subagent_type: z.string(),
      run_in_background: z.boolean().optional(),
      include_history: z.boolean().optional(),
    }),
    execute: async (args) => {
      if (!context.userMessageId) {
        return "Cannot create a task without a user message context.";
      }
      const result = await ctx.runAction(api.agent.tasks.runSubagent, {
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

  const TaskOutput = tool({
    description: "Get the result of a subagent task.",
    inputSchema: z.object({
      task_id: z.string(),
    }),
    execute: async (args) => {
      try {
        const record = await ctx.runQuery(api.agent.tasks.getOutputByExternalId, {
          taskId: args.task_id,
        });
        if (!record) return `Task not found: ${args.task_id}`;
        return formatTaskResult(record as any);
      } catch {
        return `Failed to load task: ${args.task_id}`;
      }
    },
  });

  const TaskCancel = tool({
    description: "Cancel a running subagent task.",
    inputSchema: z.object({
      task_id: z.string(),
      reason: z.string().optional(),
    }),
    execute: async (args) => {
      const record = await ctx.runMutation(api.agent.tasks.cancelTask, {
        taskId: args.task_id as Id<"tasks">,
        reason: args.reason,
      });
      if (!record) return `Task not found: ${args.task_id}`;
      return formatTaskResult(record as any);
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

      const result = await ctx.runAction(api.agent.invoke.invoke, {
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
    TaskCreate,
    TaskOutput,
    TaskCancel,
    AgentInvoke,
    MemorySearch: createMemorySearchTool(ctx, options),
  };
};

/**
 * Deviceless orchestration tools — includes MemorySearch (pure DB query)
 * but excludes Task/AgentInvoke (which need device context for subagent tools).
 */
export const createOrchestrationToolsWithoutDevice = (
  ctx: ActionCtx,
  options: ToolOptions,
): ToolSet => {
  return {
    MemorySearch: createMemorySearchTool(ctx, options),
  };
};

const createMemorySearchTool = (ctx: ActionCtx, options: ToolOptions) =>
  tool({
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
          ctx.runQuery(internal.data.memory.listCategories, { ownerId: options.ownerId }),
          ctx.runAction(internal.data.memory.search, {
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
