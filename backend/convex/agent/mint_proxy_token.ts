import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { requireUserId } from "../auth";
import { buildSystemPrompt } from "./prompt_builder";
import { getModelConfig } from "./model";

type MintResult = {
  systemPrompt: string;
  dynamicContext: string;
  toolsAllowlist?: string[];
  model: string;
  fallbackModel?: string;
  maxTaskDepth: number;
  defaultSkills: string[];
  skillIds: string[];
  proxyToken: { token: string; expiresAt: number };
  gatewayApiKey?: string;
};

/**
 * Lightweight action that returns everything the server controls:
 * system prompt, model config, skills, and proxy token.
 *
 * Does NOT return thread history, core memory, or local runtime
 * preferences (codex engine, concurrency) — those are read locally.
 */
export const mintProxyToken: ReturnType<typeof action> = action({
  args: {
    agentType: v.string(),
    runId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    platform: v.optional(v.string()),
    timezone: v.optional(v.string()),
  },
  returns: v.object({
    systemPrompt: v.string(),
    dynamicContext: v.string(),
    toolsAllowlist: v.optional(v.array(v.string())),
    model: v.string(),
    fallbackModel: v.optional(v.string()),
    maxTaskDepth: v.number(),
    defaultSkills: v.array(v.string()),
    skillIds: v.array(v.string()),
    proxyToken: v.object({
      token: v.string(),
      expiresAt: v.number(),
    }),
    gatewayApiKey: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<MintResult> => {
    const ownerId = await requireUserId(ctx);

    // Build system prompt (includes skills, platform guidance, expression style)
    const promptBuild = await buildSystemPrompt(ctx, args.agentType, {
      ownerId,
      conversationId: args.conversationId,
      platform: args.platform,
      timezone: args.timezone,
    });

    // Resolve model
    const modelDefaults = getModelConfig(args.agentType);
    let model = modelDefaults.model;
    try {
      const override = await ctx.runQuery(
        internal.data.preferences.getPreferenceForOwner,
        { ownerId, key: `model_config:${args.agentType}` },
      );
      if (typeof override === "string" && override.trim().length > 0) {
        model = override.trim();
      }
    } catch {
      // Ignore — defaults remain valid
    }

    // Mint proxy token
    const proxyToken: { token: string; expiresAt: number } = await ctx.runMutation(
      internal.ai_proxy_data.mintProxyToken,
      { ownerId, agentType: args.agentType, runId: args.runId },
    );

    return {
      systemPrompt: promptBuild.systemPrompt,
      dynamicContext: promptBuild.dynamicContext,
      toolsAllowlist: promptBuild.toolsAllowlist,
      model,
      fallbackModel: modelDefaults.fallback,
      maxTaskDepth: promptBuild.maxTaskDepth,
      defaultSkills: promptBuild.defaultSkills,
      skillIds: promptBuild.skillIds,
      proxyToken,
      gatewayApiKey: process.env.AI_GATEWAY_API_KEY,
    };
  },
});
