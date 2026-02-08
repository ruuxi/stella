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
    description:
      "Delegate a task to a subagent for execution.\n\n" +
      "Usage:\n" +
      "- description: short summary for logging (e.g. \"Search for React components\").\n" +
      "- prompt: the full instructions the subagent will follow. Be specific — the subagent only sees this prompt.\n" +
      "- subagent_type: which agent to use — \"memory\" (context lookup), \"general\" (files, shell, web, coding), \"self_mod\" (UI changes), \"explore\" (codebase search), \"browser\" (web automation).\n" +
      "- run_in_background=true: returns immediately with a task_id. Poll with TaskOutput later. Use for parallel tasks.\n" +
      "- include_history=true: passes conversation context to the subagent. Use for follow-up requests or when the subagent needs to understand what was discussed.",
    inputSchema: z.object({
      description: z.string().describe("Short summary for logging"),
      prompt: z.string().describe("Full instructions for the subagent"),
      subagent_type: z.string().describe("Agent type: memory, general, self_mod, explore, or browser"),
      run_in_background: z.boolean().optional().describe("Return immediately and poll later with TaskOutput"),
      include_history: z.boolean().optional().describe("Pass conversation context to the subagent"),
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
    description:
      "Get the result of a background subagent task.\n\n" +
      "Use after TaskCreate with run_in_background=true to poll for completion.\n\n" +
      "Returns one of:\n" +
      "- Task completed: includes the subagent's full result text and duration.\n" +
      "- Task running: the task is still in progress. Wait and poll again.\n" +
      "- Task failed/canceled: includes the error or cancellation reason.\n\n" +
      "Tips:\n" +
      "- If running multiple background tasks, poll them in sequence or batch — avoid tight polling loops.\n" +
      "- The task_id is returned by TaskCreate when run_in_background=true.",
    inputSchema: z.object({
      task_id: z.string().describe("Task ID returned by TaskCreate"),
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
      "Invoke a subagent synchronously and get structured JSON back.\n\n" +
      "Unlike TaskCreate (async, freeform text result), AgentInvoke runs inline, blocks until done, " +
      "and returns structured data conforming to result_schema.\n\n" +
      "Use cases:\n" +
      "- Extract structured information (e.g. parse a page into a typed object).\n" +
      "- Get a JSON result you can process programmatically.\n" +
      "- Bounded operations that should complete quickly (max 8 steps).\n\n" +
      "Parameters:\n" +
      "- agent_type: which agent to invoke (e.g. \"general\", \"explore\", \"memory\").\n" +
      "- prompt: instructions for the subagent (what to do and return).\n" +
      "- input: optional structured data to pass to the subagent as context.\n" +
      "- result_schema: JSON Schema describing the expected return shape. The subagent is forced to output JSON matching this schema.\n" +
      "- max_steps: limit on tool-calling rounds (1-8, default varies). Lower = faster but less capable.\n" +
      "- mode: optional execution mode hint.\n\n" +
      "Prefer TaskCreate for long-running work, parallel execution, or when you don't need structured output.",
    inputSchema: z.object({
      agent_type: z.string().min(1).describe("Agent type to invoke (e.g. general, explore, memory)"),
      mode: z.string().optional().describe("Execution mode hint"),
      prompt: z.string().optional().describe("Instructions for the subagent"),
      input: z.any().optional().describe("Structured data to pass as context"),
      result_schema: z.any().optional().describe("JSON Schema for the expected return shape"),
      max_steps: z.number().int().positive().max(8).optional().describe("Max tool-calling rounds (1-8)"),
      target_device_id: z.string().optional().describe("Device to target (defaults to current)"),
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
