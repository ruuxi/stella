import { tool, ToolSet } from "ai";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { DeviceToolContext } from "../agent/device_tools";
import { type ToolOptions } from "./types";

const SUBAGENT_TYPES = ["general", "self_mod", "explore", "browser"] as const;
const subagentTypeSchema = z.enum(SUBAGENT_TYPES);

const formatTaskResult = (task: {
  _id: Id<"tasks">;
  conversationId: Id<"conversations">;
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
  const updates = task.statusUpdates ?? [];
  if (updates.length > 0) {
    const activity = updates.map((u) => `- ${u.text}`).join("\n");
    return `Task running.\nTask ID: ${task._id}\nElapsed: ${duration}ms\n\nRecent activity:\n${activity}`;
  }
  return `Task running.\nTask ID: ${task._id}\nElapsed: ${duration}ms`;
};

const createTaskTools = (
  ctx: ActionCtx,
  options: ToolOptions,
  context?: DeviceToolContext,
): ToolSet => {
  const TaskCreate = tool({
    description:
      "Delegate a task to a subagent for execution.\n\n" +
      "The task runs in the background and returns immediately with a task_id. Results are auto-delivered when the agent finishes.\n\n" +
      "Usage:\n" +
      "- description: short summary for logging (e.g. \"Search for React components\").\n" +
      "- prompt: the full instructions the subagent will follow. Be specific - the subagent only sees this prompt.\n" +
      "- subagent_type: which agent to use - \"general\" (files, shell, web, coding), \"self_mod\" (UI changes), \"explore\" (codebase search), \"browser\" (web automation).\n" +
      "- include_history=true: passes conversation context to the subagent. Use for follow-up requests or when the subagent needs to understand what was discussed.\n\n" +
      "Pre-gathered context:\n" +
      "- recall_memory: automatically recall memories and inject them into the agent's context before it runs. Provide a query (defaults to task description).\n" +
      "- pre_explore: run an explore agent first with the given prompt, then inject its findings into the main agent's context.\n\n" +
      "Threads (general and self_mod only):\n" +
      "- thread_id: continue an existing thread - the agent sees its full prior message history and picks up where it left off.\n" +
      "- thread_name: create or reuse a named thread (short, kebab-case, e.g. \"sidebar-refactor\"). If an active thread with this name exists, it's reused.\n" +
      "- Use threads for multi-step work, iterative tasks, or follow-ups on the same topic. Skip for one-shot tasks or explore agents.\n\n" +
      "Multiple tasks can run in parallel - call TaskCreate multiple times.",
    inputSchema: z.object({
      description: z.string().describe("Short summary for logging"),
      prompt: z.string().describe("Full instructions for the subagent"),
      subagent_type: subagentTypeSchema.describe("Agent type: general, self_mod, explore, or browser"),
      include_history: z.boolean().optional().describe("Pass conversation context to the subagent"),
      thread_id: z.string().optional().describe(
        "Continue an existing thread by ID. Agent sees full prior history.",
      ),
      thread_name: z.string().optional().describe(
        "Create a new thread with this name, or reuse an existing active thread with the same name (short, descriptive, kebab-case).",
      ),
      recall_memory: z.object({
        query: z.string().optional().describe("What to recall - defaults to the task description"),
      }).optional().describe(
        "Automatically recall memories and inject into the agent's context before it runs.",
      ),
      pre_explore: z.string().optional().describe(
        "Run an explore agent with this prompt first, then inject its findings into the main agent's context.",
      ),
      command_id: z.string().optional().describe(
        "Command ID to load full instructions into the subagent's prompt. " +
        "The system resolves the content automatically - do not include command instructions in the prompt.",
      ),
    }),
    execute: async (args) => {
      const conversationId = context?.conversationId ?? options.conversationId;
      const userMessageId = context?.userMessageId ?? options.userMessageId;
      const targetDeviceId = context?.targetDeviceId ?? options.targetDeviceId;

      if (!conversationId || !userMessageId) {
        return "Cannot create a task without a conversation and user message context.";
      }

      const result = await ctx.runAction(internal.agent.tasks.runSubagent, {
        conversationId,
        userMessageId,
        targetDeviceId,
        description: args.description,
        prompt: args.prompt,
        subagentType: args.subagent_type,
        parentTaskId: options.currentTaskId,
        includeHistory: args.include_history,
        threadId: args.thread_id,
        threadName: args.thread_name,
        recallMemory: args.recall_memory,
        preExplore: args.pre_explore,
        commandId: args.command_id,
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
      "- If running multiple tasks, poll them in sequence - avoid tight polling loops.\n" +
      "- The task_id is returned by TaskCreate.",
    inputSchema: z.object({
      task_id: z.string().describe("Task ID returned by TaskCreate"),
    }),
    execute: async (args) => {
      const conversationId = context?.conversationId ?? options.conversationId;
      if (!conversationId) {
        return "TaskOutput requires a conversation context.";
      }

      try {
        const record = await ctx.runQuery(internal.agent.tasks.getOutputByExternalIdInternal, {
          taskId: args.task_id,
        });
        if (!record || record.conversationId !== conversationId) {
          return `Task not found: ${args.task_id}`;
        }
        return formatTaskResult(record as any);
      } catch {
        return `Failed to load task: ${args.task_id}`;
      }
    },
  });

  const TaskCancel = tool({
    description:
      "Cancel a running subagent task.\n\n" +
      "Use to stop a background task that is no longer needed - for example, if the user changes their mind " +
      "or if a parallel task already produced the answer.\n\n" +
      "The task will be marked as canceled. If the subagent has already finished, cancellation has no effect " +
      "and you'll receive the completed result instead.",
    inputSchema: z.object({
      task_id: z.string().describe("Task ID to cancel"),
      reason: z.string().optional().describe("Why the task is being canceled (logged for debugging)"),
    }),
    execute: async (args) => {
      const conversationId = context?.conversationId ?? options.conversationId;
      if (!conversationId) {
        return "TaskCancel requires a conversation context.";
      }

      const current = await ctx.runQuery(internal.agent.tasks.getOutputByExternalIdInternal, {
        taskId: args.task_id,
      });
      if (!current || current.conversationId !== conversationId) {
        return `Task not found: ${args.task_id}`;
      }

      const record = await ctx.runMutation(internal.agent.tasks.cancelTaskInternal, {
        taskId: args.task_id as Id<"tasks">,
        reason: args.reason,
      });
      if (!record || record.conversationId !== conversationId) {
        return `Task not found: ${args.task_id}`;
      }
      return formatTaskResult(record as any);
    },
  });

  return {
    TaskCreate,
    TaskOutput,
    TaskCancel,
  };
};

export const createOrchestrationTools = (
  ctx: ActionCtx,
  context: DeviceToolContext,
  options: ToolOptions,
): ToolSet => {
  return {
    ...createTaskTools(ctx, options, context),
    RecallMemories: createRecallMemoriesTool(ctx, options),
    SaveMemory: createSaveMemoryTool(ctx, options),
  };
};

/**
 * Deviceless orchestration tools - include memory tools always.
 * Task tools are enabled when conversation + user message context is available.
 */
export const createOrchestrationToolsWithoutDevice = (
  ctx: ActionCtx,
  options: ToolOptions,
): ToolSet => {
  const baseTools: ToolSet = {
    RecallMemories: createRecallMemoriesTool(ctx, options),
    SaveMemory: createSaveMemoryTool(ctx, options),
  };

  if (!options.conversationId || !options.userMessageId) {
    return baseTools;
  }

  return {
    ...createTaskTools(ctx, options),
    ...baseTools,
  };
};

const createRecallMemoriesTool = (ctx: ActionCtx, options: ToolOptions) =>
  tool({
    description:
      "Look up relevant memories from past conversations.\n\n" +
      "Provide a natural language query describing what you need. Returns relevant memories ranked by similarity.\n\n" +
      "Use when:\n" +
      "- The user references something from a previous conversation (\"remember when...\", \"like last time\").\n" +
      "- You need historical context (user preferences, past decisions, prior work).\n" +
      "- You want to check if something was discussed or decided before.\n\n" +
      "Tips:\n" +
      "- Use specific queries for better results (\"user's preferred programming language\" not just \"preferences\").\n" +
      "- If no results match, try rephrasing or using broader queries.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Natural language query describing what you need"),
    }),
    execute: async (args) => {
      if (!options.ownerId) {
        return "RecallMemories requires an authenticated owner context.";
      }
      try {
        return await ctx.runAction(internal.data.memory.recallMemories, {
          ownerId: options.ownerId,
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
      "Use when you learn something about the user worth persisting - preferences, decisions, personal details, " +
      "project context, or any fact that would be useful in future conversations.\n\n" +
      "The system automatically deduplicates: if a similar memory already exists, it will be skipped.\n\n" +
      "Each memory should be a coherent thought (1-3 sentences), not a bare keyword or a long document.",
    inputSchema: z.object({
      content: z.string().min(1).describe("The information to remember (1-3 coherent sentences)"),
    }),
    execute: async (args) => {
      if (!options.ownerId) {
        return "SaveMemory requires an authenticated owner context.";
      }
      try {
        return await ctx.runAction(internal.data.memory.saveMemory, {
          ownerId: options.ownerId,
          content: args.content,
          conversationId: options.conversationId,
        });
      } catch (error) {
        return `SaveMemory failed: ${(error as Error).message}`;
      }
    },
  });
