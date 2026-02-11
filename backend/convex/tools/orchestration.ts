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
      "The task runs in the background and returns immediately with a task_id. Results are auto-delivered when the agent finishes.\n\n" +
      "Usage:\n" +
      "- description: short summary for logging (e.g. \"Search for React components\").\n" +
      "- prompt: the full instructions the subagent will follow. Be specific — the subagent only sees this prompt.\n" +
      "- subagent_type: which agent to use — \"general\" (files, shell, web, coding), \"self_mod\" (UI changes), \"explore\" (codebase search), \"browser\" (web automation).\n" +
      "- include_history=true: passes conversation context to the subagent. Use for follow-up requests or when the subagent needs to understand what was discussed.\n\n" +
      "Pre-gathered context:\n" +
      "- recall_memory: automatically recall memories and inject them into the agent's context before it runs. Provide a query (defaults to task description) and optional category filters.\n" +
      "- pre_explore: run an explore agent first with the given prompt, then inject its findings into the main agent's context.\n\n" +
      "Threads (general and self_mod only):\n" +
      "- thread_id: continue an existing thread — the agent sees its full prior message history and picks up where it left off.\n" +
      "- thread_name: create or reuse a named thread (short, kebab-case, e.g. \"sidebar-refactor\"). If an active thread with this name exists, it's reused.\n" +
      "- Use threads for multi-step work, iterative tasks, or follow-ups on the same topic. Skip for one-shot tasks or explore agents.\n\n" +
      "Multiple tasks can run in parallel — call TaskCreate multiple times.",
    inputSchema: z.object({
      description: z.string().describe("Short summary for logging"),
      prompt: z.string().describe("Full instructions for the subagent"),
      subagent_type: z.string().describe("Agent type: general, self_mod, explore, or browser"),
      include_history: z.boolean().optional().describe("Pass conversation context to the subagent"),
      thread_id: z.string().optional().describe(
        "Continue an existing thread by ID. Agent sees full prior history.",
      ),
      thread_name: z.string().optional().describe(
        "Create a new thread with this name, or reuse an existing active thread with the same name (short, descriptive, kebab-case).",
      ),
      activate_skills: z.array(z.string()).optional().describe(
        "Skill IDs to pre-activate. Injects full skill documentation and grants access to the skill's specialized tools. Use for store operations (\"store-management\"), API skill creation (\"api-skill-generation\"), or media generation (\"media-generation\").",
      ),
      recall_memory: z.object({
        query: z.string().optional().describe("What to recall — defaults to the task description"),
        categories: z.array(z.object({
          category: z.string(),
          subcategory: z.string(),
        })).optional().describe("Category/subcategory pairs to search — defaults to all categories"),
      }).optional().describe(
        "Automatically recall memories and inject into the agent's context before it runs.",
      ),
      pre_explore: z.string().optional().describe(
        "Run an explore agent with this prompt first, then inject its findings into the main agent's context.",
      ),
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
        threadId: args.thread_id,
        threadName: args.thread_name,
        activateSkills: args.activate_skills,
        recallMemory: args.recall_memory,
        preExplore: args.pre_explore,
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
    RecallMemories: createRecallMemoriesTool(ctx, options),
    SaveMemory: createSaveMemoryTool(ctx, options),
  };
};

/**
 * Deviceless orchestration tools — includes memory tools (pure DB query + cheap LLM)
 * but excludes Task tools (which need device context for subagent tools).
 */
export const createOrchestrationToolsWithoutDevice = (
  ctx: ActionCtx,
  options: ToolOptions,
): ToolSet => {
  return {
    RecallMemories: createRecallMemoriesTool(ctx, options),
    SaveMemory: createSaveMemoryTool(ctx, options),
  };
};

const createRecallMemoriesTool = (ctx: ActionCtx, options: ToolOptions) =>
  tool({
    description:
      "Look up relevant memories from past conversations.\n\n" +
      "Provide 1-3 category/subcategory pairs from the Memory Categories tree in your system prompt, " +
      "plus a natural language query. Returns a synthesized context summary.\n\n" +
      "Use when:\n" +
      "- The user references something from a previous conversation (\"remember when...\", \"like last time\").\n" +
      "- You need historical context (user preferences, past decisions, prior work).\n" +
      "- You want to check if something was discussed or decided before.\n\n" +
      "Tips:\n" +
      "- Check the Memory Categories tree to pick the right category/subcategory pairs.\n" +
      "- Use specific queries for better results (\"user's preferred programming language\" not just \"preferences\").\n" +
      "- If no results match, try different category pairs or broader queries.",
    inputSchema: z.object({
      categories: z.array(z.object({
        category: z.string().describe("Memory category (e.g. \"preferences\", \"projects\")"),
        subcategory: z.string().describe("Memory subcategory (e.g. \"coding\", \"setup\")"),
      })).min(1).max(3).describe("1-3 category/subcategory pairs to search"),
      query: z.string().min(1).describe("Natural language query describing what you need"),
    }),
    execute: async (args) => {
      if (!options.ownerId) {
        return "RecallMemories requires an authenticated owner context.";
      }
      try {
        return await ctx.runAction(internal.data.memory.recallMemories, {
          ownerId: options.ownerId,
          categories: args.categories,
          query: args.query,
        });
      } catch (error) {
        return `RecallMemories failed: ${(error as Error).message}`;
      }
    },
  });

const createSaveMemoryTool = (ctx: ActionCtx, options: ToolOptions) =>
  tool({
    description:
      "Save something worth remembering across conversations.\n\n" +
      "Use when you learn something about the user worth persisting — preferences, decisions, personal details, " +
      "project context, or any fact that would be useful in future conversations.\n\n" +
      "The system automatically deduplicates: if a similar memory already exists in the same category/subcategory, " +
      "it will be updated rather than duplicated.\n\n" +
      "Pick category/subcategory from the Memory Categories tree, or create new ones if needed.\n\n" +
      "Each memory should be a coherent thought (1-3 sentences), not a bare keyword or a long document.",
    inputSchema: z.object({
      category: z.string().describe("Memory category (e.g. \"preferences\", \"projects\", \"personal\")"),
      subcategory: z.string().describe("Memory subcategory (e.g. \"coding\", \"setup\", \"family\")"),
      content: z.string().min(1).describe("The information to remember (1-3 coherent sentences)"),
    }),
    execute: async (args) => {
      if (!options.ownerId) {
        return "SaveMemory requires an authenticated owner context.";
      }
      try {
        return await ctx.runAction(internal.data.memory.saveMemory, {
          ownerId: options.ownerId!,
          category: args.category,
          subcategory: args.subcategory,
          content: args.content,
          conversationId: options.conversationId,
        });
      } catch (error) {
        return `SaveMemory failed: ${(error as Error).message}`;
      }
    },
  });
