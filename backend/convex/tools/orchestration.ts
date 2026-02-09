import { tool, ToolSet } from "ai";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { DeviceToolContext } from "../agent/device_tools";
import { type ToolOptions } from "./types";

const formatTaskResult = (task: {
  _id: Id<"tasks">;
  status: string;
  result?: string;
  error?: string;
  statusUpdates?: Array<{ text: string; timestamp: number }>;
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
  // Running — include recent activity if available
  const updates = task.statusUpdates ?? [];
  if (updates.length > 0) {
    const activity = updates.map((u) => `- ${u.text}`).join("\n");
    return `Task running.\nTask ID: ${task._id}\nElapsed: ${duration}ms\n\nRecent activity:\n${activity}`;
  }
  return `Task running.\nTask ID: ${task._id}\nElapsed: ${duration}ms`;
};

export const createOrchestrationTools = (
  ctx: ActionCtx,
  context: DeviceToolContext,
  options: ToolOptions,
): ToolSet => {
  const TaskCreate = tool({
    description:
      "Delegate a task to a subagent for execution.\n\n" +
      "The task runs in the background and returns immediately with a task_id. Use TaskOutput to poll for results.\n\n" +
      "Usage:\n" +
      "- description: short summary for logging (e.g. \"Search for React components\").\n" +
      "- prompt: the full instructions the subagent will follow. Be specific — the subagent only sees this prompt.\n" +
      "- subagent_type: which agent to use — \"memory\" (context lookup), \"general\" (files, shell, web, coding), \"self_mod\" (UI changes), \"explore\" (codebase search), \"browser\" (web automation).\n" +
      "- include_history=true: passes conversation context to the subagent. Use for follow-up requests or when the subagent needs to understand what was discussed.\n\n" +
      "Multiple tasks can run in parallel — call TaskCreate multiple times, then poll each with TaskOutput.",
    inputSchema: z.object({
      description: z.string().describe("Short summary for logging"),
      prompt: z.string().describe("Full instructions for the subagent"),
      subagent_type: z.string().describe("Agent type: memory, general, self_mod, explore, or browser"),
      include_history: z.boolean().optional().describe("Pass conversation context to the subagent"),
      // thread_id: z.string().optional().describe("Continue an existing thread"),
      // thread_title: z.string().optional().describe("Create a new thread with this title"),
    }),
    execute: async (args) => {
      if (!context.userMessageId) {
        return "Cannot create a task without a user message context.";
      }

      const result = await ctx.runAction(internal.agent.tasks.runSubagent, {
        conversationId: context.conversationId,
        userMessageId: context.userMessageId,
        targetDeviceId: context.targetDeviceId,
        description: args.description,
        prompt: args.prompt,
        subagentType: args.subagent_type,
        parentTaskId: options.currentTaskId,
        includeHistory: args.include_history,
      });
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  const TaskOutput = tool({
    description:
      "Get the result of a background subagent task.\n\n" +
      "Poll for the result of a subagent task.\n\n" +
      "Returns one of:\n" +
      "- Task completed: includes the subagent's full result text and duration.\n" +
      "- Task running: the task is still in progress. Wait and poll again.\n" +
      "- Task failed/canceled: includes the error or cancellation reason.\n\n" +
      "Tips:\n" +
      "- If running multiple tasks, poll them in sequence — avoid tight polling loops.\n" +
      "- The task_id is returned by TaskCreate.",
    inputSchema: z.object({
      task_id: z.string().describe("Task ID returned by TaskCreate"),
    }),
    execute: async (args) => {
      try {
        const record = await ctx.runQuery(internal.agent.tasks.getOutputByExternalIdInternal, {
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
    description:
      "Cancel a running subagent task.\n\n" +
      "Use to stop a background task that is no longer needed — for example, if the user changes their mind " +
      "or if a parallel task already produced the answer.\n\n" +
      "The task will be marked as canceled. If the subagent has already finished, cancellation has no effect " +
      "and you'll receive the completed result instead.",
    inputSchema: z.object({
      task_id: z.string().describe("Task ID to cancel"),
      reason: z.string().optional().describe("Why the task is being canceled (logged for debugging)"),
    }),
    execute: async (args) => {
      const record = await ctx.runMutation(internal.agent.tasks.cancelTaskInternal, {
        taskId: args.task_id as Id<"tasks">,
        reason: args.reason,
      });
      if (!record) return `Task not found: ${args.task_id}`;
      return formatTaskResult(record as any);
    },
  });

  return {
    TaskCreate,
    TaskOutput,
    TaskCancel,
    MemorySearch: createMemorySearchTool(ctx, options),
  };
};

/**
 * Deviceless orchestration tools — includes MemorySearch (pure DB query)
 * but excludes Task tools (which need device context for subagent tools).
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
      "Search the user's episodic memory for relevant past context.\n\n" +
      "Memories are stored from past conversations and tasks. Use when:\n" +
      "- The user references something from a previous conversation (\"remember when...\", \"like last time\").\n" +
      "- You need historical context to answer a question (user preferences, past decisions, prior work).\n" +
      "- You want to check if something was discussed or decided before.\n\n" +
      "The response includes:\n" +
      "1. Available categories — a tree of category/subcategory with counts. Use this to discover what's stored.\n" +
      "2. Matched memories — the most relevant memories for your query.\n\n" +
      "Tips:\n" +
      "- Use natural language queries (\"user's preferred programming language\", \"previous project setup\").\n" +
      "- Use the category filter to narrow results when you know the domain (e.g. category=\"preferences\").\n" +
      "- If no results match, try broader or rephrased queries.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Natural language search query"),
      category: z.string().optional().describe("Filter to a specific category (e.g. \"preferences\", \"projects\")"),
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
