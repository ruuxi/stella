import { tool, ToolSet } from "ai";
import { z } from "zod";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { DeviceToolContext } from "../device_tools";
import { TASK_POLL_INTERVAL_MS, TASK_MAX_TIMEOUT_MS, type ToolOptions } from "./types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

export const createOrchestrationTools = (
  ctx: ActionCtx,
  context: DeviceToolContext,
  options: ToolOptions,
): ToolSet => {
  const Task = tool({
    description: "Delegate a task to a specialized subagent.",
    inputSchema: z.object({
      description: z.string().min(1),
      prompt: z.string().min(1),
      subagent_type: z.string().min(1),
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
        runInBackground: args.run_in_background,
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
      const timeoutMs = Math.min(
        Math.max(Math.floor(args.timeout ?? 20_000), TASK_POLL_INTERVAL_MS),
        TASK_MAX_TIMEOUT_MS,
      );
      const deadline = Date.now() + timeoutMs;
      try {
        let record = await ctx.runQuery(api.tasks.getOutputByExternalId, {
          taskId: args.task_id,
        });
        if (!record) {
          return `Task not found: ${args.task_id}`;
        }
        if (!args.block || record.status !== "running") {
          return formatTaskResult(record as any);
        }

        while (Date.now() < deadline) {
          await sleep(TASK_POLL_INTERVAL_MS);
          record = await ctx.runQuery(api.tasks.getOutputByExternalId, {
            taskId: args.task_id,
          });
          if (!record) {
            return `Task not found: ${args.task_id}`;
          }
          if (record.status !== "running") {
            return formatTaskResult(record as any);
          }
        }

        return formatTaskResult(record as any);
      } catch {
        return `Failed to load task: ${args.task_id}`;
      }
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
    TaskOutput,
    AgentInvoke,
    MemorySearch,
  };
};
