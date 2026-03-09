import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction, requireUserId } from "../auth";
import { createBackendTools, executeWebSearch } from "../tools/backend";
import { jsonValueValidator } from "../shared_validators";

const DEFAULT_MAX_TASK_DEPTH = 2;
const ALLOWED_LOCAL_RUNTIME_BACKEND_TOOLS = new Set([
  "WebSearch",
  "WebFetch",
  "IntegrationRequest",
  "ActivateSkill",
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
    agentType: args.agentType ?? "general",
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

export const webSearch = action({
  args: {
    query: v.string(),
    category: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    agentType: v.optional(v.string()),
    searchHtmlSystemPrompt: v.optional(v.string()),
    searchHtmlUserPromptTemplate: v.optional(v.string()),
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
    html: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    if (args.conversationId) {
      await requireConversationOwnerAction(ctx, args.conversationId);
    }
    return await executeWebSearch(ctx, args.query, {
      ownerId,
      includeHtml: true,
      searchHtmlPromptConfig:
        args.searchHtmlSystemPrompt?.trim() && args.searchHtmlUserPromptTemplate?.trim()
          ? {
              systemPrompt: args.searchHtmlSystemPrompt.trim(),
              userPromptTemplate: args.searchHtmlUserPromptTemplate.trim(),
            }
          : undefined,
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
