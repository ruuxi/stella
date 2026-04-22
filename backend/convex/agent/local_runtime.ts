import { ConvexError } from "convex/values";
import { action } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction, requireUserId } from "../auth";
import {
  AGENT_IDS,
  BACKEND_TOOL_IDS,
  LOCAL_RUNTIME_BACKEND_TOOL_NAMES,
} from "../lib/agent_constants";
import {
  enforceActionRateLimit,
  RATE_EXPENSIVE,
  RATE_STANDARD,
} from "../lib/rate_limits";
import { createBackendTools, executeWebSearch } from "../tools/backend";
import { jsonValueValidator } from "../shared_validators";

const DEFAULT_MAX_TASK_DEPTH = 2;
const ALLOWED_LOCAL_RUNTIME_BACKEND_TOOLS = new Set<string>(
  LOCAL_RUNTIME_BACKEND_TOOL_NAMES,
);

const toToolResultText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);

const executeBackendTool = async (
  ctx: Parameters<typeof createBackendTools>[0],
  args: {
    ownerId: string;
    conversationId?: Id<"conversations">;
    agentType?: string;
  },
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<string> => {
  if (!ALLOWED_LOCAL_RUNTIME_BACKEND_TOOLS.has(toolName)) {
    throw new ConvexError(`Tool ${toolName} is not allowed from local runtime`);
  }
  const tools = createBackendTools(ctx, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    agentType: args.agentType ?? AGENT_IDS.GENERAL,
    maxTaskDepth: DEFAULT_MAX_TASK_DEPTH,
  }) as Record<
    string,
    { execute?: (input: Record<string, unknown>) => Promise<unknown> }
  >;

  const tool = tools[toolName];
  if (!tool?.execute) {
    throw new ConvexError(`${toolName} is unavailable`);
  }

  const output = await tool.execute(toolArgs);
  return toToolResultText(output);
};

export const executeTool = action({
  args: {
    toolName: v.string(),
    toolArgs: v.optional(jsonValueValidator),
    conversationId: v.optional(v.id("conversations")),
    agentType: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceActionRateLimit(
      ctx,
      "agent_local_runtime_execute_tool",
      ownerId,
      RATE_STANDARD,
      "Too many tool invocations. Please wait a moment and try again.",
    );
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }

    const toolArgs =
      args.toolArgs && typeof args.toolArgs === "object"
        ? (args.toolArgs as Record<string, unknown>)
        : {};

    return await executeBackendTool(
      ctx,
      {
        ownerId,
        conversationId: args.conversationId,
        agentType: args.agentType,
      },
      args.toolName,
      toolArgs,
    );
  },
});

export const webSearch = action({
  args: {
    query: v.string(),
    category: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    agentType: v.optional(v.string()),
  },
  returns: v.object({
    text: v.string(),
    results: v.array(
      v.object({
        title: v.string(),
        url: v.string(),
        snippet: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    // Outbound HTTP on the user's behalf — without a cap, the backend
    // becomes a free crawler.
    await enforceActionRateLimit(
      ctx,
      "agent_local_runtime_web_search",
      ownerId,
      RATE_EXPENSIVE,
      "Too many web searches. Please wait a moment and try again.",
    );
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }
    return await executeWebSearch(ctx, args.query, {
      ownerId,
      category: args.category,
    });
  },
});

export const webFetch = action({
  args: {
    url: v.string(),
    prompt: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    agentType: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceActionRateLimit(
      ctx,
      "agent_local_runtime_web_fetch",
      ownerId,
      RATE_EXPENSIVE,
      "Too many web fetches. Please wait a moment and try again.",
    );
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }
    return await executeBackendTool(
      ctx,
      {
        ownerId,
        conversationId: args.conversationId,
        agentType: args.agentType,
      },
      BACKEND_TOOL_IDS.WEB_FETCH,
      { url: args.url, prompt: args.prompt },
    );
  },
});

