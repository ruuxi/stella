import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction, requireUserId } from "../auth";
import { createBackendTools } from "../tools/backend";
import { jsonValueValidator } from "../shared_validators";

const DEFAULT_MAX_TASK_DEPTH = 2;
const ALLOWED_LOCAL_RUNTIME_BACKEND_TOOLS = new Set([
  "WebSearch",
  "WebFetch",
  "IntegrationRequest",
  "ActivateSkill",
  "HeartbeatGet",
  "HeartbeatUpsert",
  "HeartbeatRun",
  "CronList",
  "CronAdd",
  "CronUpdate",
  "CronRemove",
  "CronRun",
  "OpenCanvas",
  "CloseCanvas",
  "GenerateApiSkill",
  "ListResources",
  "NoResponse",
]);

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
    throw new Error(`Tool ${toolName} is not allowed from local runtime`);
  }
  const tools = createBackendTools(ctx, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    agentType: args.agentType ?? "orchestrator",
    maxTaskDepth: DEFAULT_MAX_TASK_DEPTH,
  }) as Record<string, { execute?: (input: Record<string, unknown>) => Promise<unknown> }>;

  const tool = tools[toolName];
  if (!tool?.execute) {
    throw new Error(`${toolName} is unavailable`);
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
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }

    const toolArgs =
      args.toolArgs && typeof args.toolArgs === "object"
        ? (args.toolArgs as Record<string, unknown>)
        : {};

    return await executeBackendTool(
      ctx,
      { ownerId, conversationId: args.conversationId, agentType: args.agentType },
      args.toolName,
      toolArgs,
    );
  },
});

export const recallMemories = action({
  args: {
    query: v.string(),
    source: v.optional(v.union(v.literal("memory"), v.literal("history"))),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const ownerId = await requireUserId(ctx);
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }

    const text = await ctx.runAction(internal.data.memory.recallMemories, {
      ownerId,
      query: args.query,
      source: args.source,
      conversationId: args.conversationId,
    });
    return text || "No relevant memories found.";
  },
});

export const saveMemory = action({
  args: {
    content: v.string(),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const ownerId = await requireUserId(ctx);
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }

    return await ctx.runAction(internal.data.memory.saveMemory, {
      ownerId,
      content: args.content,
      conversationId: args.conversationId,
    });
  },
});

export const webSearch = action({
  args: {
    query: v.string(),
    conversationId: v.optional(v.id("conversations")),
    agentType: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }
    return await executeBackendTool(
      ctx,
      { ownerId, conversationId: args.conversationId, agentType: args.agentType },
      "WebSearch",
      { query: args.query },
    );
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
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }
    return await executeBackendTool(
      ctx,
      { ownerId, conversationId: args.conversationId, agentType: args.agentType },
      "WebFetch",
      { url: args.url, prompt: args.prompt },
    );
  },
});

export const activateSkill = action({
  args: {
    skillId: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const ownerId = await requireUserId(ctx);
    const skill = await ctx.runQuery(internal.data.skills.getSkillByIdInternal, {
      skillId: args.skillId,
      ownerId,
    });

    if (!skill || !skill.markdown) {
      return `Skill '${args.skillId}' not found or has no content.`;
    }
    return skill.markdown;
  },
});
