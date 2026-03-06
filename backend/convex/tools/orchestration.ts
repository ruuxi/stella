import { tool, ToolSet } from "ai";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { type ToolOptions } from "./types";

export const createOrchestrationTools = (
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
      "Provide a natural language query describing what you need. Returns relevant memories ranked by relevance.\n\n" +
      "Use when:\n" +
      "- The user references something from a previous conversation (\"remember when...\", \"like last time\").\n" +
      "- You need historical context (user preferences, past decisions, prior work).\n" +
      "- You want to check if something was discussed or decided before.\n\n" +
      "Tips:\n" +
      "- Use specific queries for better results (\"user's preferred programming language\" not just \"preferences\").\n" +
      "- If no results match, try rephrasing or using broader queries.\n" +
      "- source defaults to \"memory\"; only use \"history\" when explicitly instructed by system context.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Natural language query describing what you need"),
      source: z.enum(["memory", "history"]).optional().describe(
        "Recall source. Defaults to memory. Use history only when system context directs it.",
      ),
    }),
    execute: async (args) => {
      if (!options.ownerId) {
        return "RecallMemories requires an authenticated owner context.";
      }
      try {
        return await ctx.runAction(internal.data.memory.recallMemories, {
          ownerId: options.ownerId,
          query: args.query,
          source: args.source,
          conversationId: options.conversationId,
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
