import type { ActionCtx } from "../_generated/server";
import { action, internalAction } from "../_generated/server";
import { ConvexError, Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction, requireUserId } from "../auth";
import { getModelConfig } from "./model";
import {
  GENERAL_AGENT_ENGINE_KEY,
  CODEX_LOCAL_MAX_CONCURRENCY_KEY,
  DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY,
  normalizeGeneralAgentEngine,
  normalizeCodexLocalMaxConcurrency,
} from "../data/preferences";
import { SKILLS_DISABLED_AGENT_TYPES } from "../lib/agent_constants";
import {
  buildSkillsPromptSection,
  getPlatformSystemGuidance,
} from "../prompts/index";

export type PromptBuildResult = {
  systemPrompt: string;
  dynamicContext: string;
  toolsAllowlist?: string[];
  maxTaskDepth: number;
  defaultSkills: string[];
  skillIds: string[];
  timezone: string;
};

type FetchAgentContextSharedArgs = {
  ownerId: string;
  conversationId: Id<"conversations">;
  agentType: string;
  runId: string;
  threadId?: Id<"threads">;
  maxHistoryMessages?: number;
  platform?: string;
  timezone?: string;
};

export const buildSystemPrompt = async (
  ctx: ActionCtx,
  agentType: string,
  options?: {
    ownerId?: string;
    conversationId?: Id<"conversations">;
    platform?: string;
    timezone?: string;
  },
): Promise<PromptBuildResult> => {
  const agent = await ctx.runQuery(internal.agent.agents.getAgentConfigInternal, {
    agentType,
    ownerId: options?.ownerId,
  });

  const skills = SKILLS_DISABLED_AGENT_TYPES.has(agentType)
    ? []
    : await ctx.runQuery(internal.data.skills.listEnabledSkillsInternal, {
        agentType,
        ownerId: options?.ownerId,
      });

  const skillsSection = buildSkillsPromptSection(
    skills.map((
      skill: {
        id: string;
        name: string;
        description: string;
        execution?: string;
        requiresSecrets?: string[];
        publicIntegration?: boolean;
        secretMounts?: Record<string, unknown>;
      },
    ) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      execution: skill.execution,
      requiresSecrets: skill.requiresSecrets,
      publicIntegration: skill.publicIntegration,
      secretMounts: skill.secretMounts,
    })),
  );

  const systemParts = [agent.systemPrompt];
  if (skillsSection) {
    systemParts.push(skillsSection);
  }

  if (options?.platform) {
    const guidance = getPlatformSystemGuidance(options.platform);
    if (guidance) {
      systemParts.push(guidance);
    }
  }

  const dynamicParts: string[] = [];

  const maxTaskDepthValue = Number(agent.maxTaskDepth);
  const maxTaskDepth = Number.isFinite(maxTaskDepthValue) && maxTaskDepthValue >= 0
    ? Math.floor(maxTaskDepthValue)
    : 2;

  return {
    systemPrompt: systemParts.join("\n\n").trim(),
    dynamicContext: dynamicParts.join("\n\n").trim(),
    toolsAllowlist: agent.toolsAllowlist,
    maxTaskDepth,
    defaultSkills: agent.defaultSkills ?? [],
    skillIds: skills.map((skill: { id: string }) => skill.id),
    timezone: options?.timezone ?? "UTC",
  };
};

// fetchAgentContext
// Returns everything the local agent runtime needs in a single round-trip:
// system prompt, dynamic context, tool allowlist, skills,
// thread history, and managed auth context for LLM access.

const agentContextResultValidator = v.object({
  systemPrompt: v.string(),
  dynamicContext: v.string(),
  toolsAllowlist: v.optional(v.array(v.string())),
  model: v.string(),
  fallbackModel: v.optional(v.string()),
  maxTaskDepth: v.number(),
  defaultSkills: v.array(v.string()),
  skillIds: v.array(v.string()),
  threadHistory: v.optional(v.array(v.object({
    role: v.string(),
    content: v.string(),
    toolCallId: v.optional(v.string()),
  }))),
  activeThreadId: v.optional(v.string()),
  gatewayApiKey: v.optional(v.string()),
  generalAgentEngine: v.optional(v.union(
    v.literal("default"),
    v.literal("codex_local"),
    v.literal("claude_code_local"),
  )),
  codexLocalMaxConcurrency: v.optional(v.number()),
});
type AgentContextResult = Infer<typeof agentContextResultValidator>;

const fetchAgentContextInternalArgs = {
  ownerId: v.string(),
  conversationId: v.id("conversations"),
  agentType: v.string(),
  runId: v.string(),
  threadId: v.optional(v.id("threads")),
  maxHistoryMessages: v.optional(v.number()),
  platform: v.optional(v.string()),
  timezone: v.optional(v.string()),
};

const fetchAgentContextRuntimeArgs = {
  conversationId: v.id("conversations"),
  agentType: v.string(),
  runId: v.string(),
  threadId: v.optional(v.id("threads")),
  maxHistoryMessages: v.optional(v.number()),
  platform: v.optional(v.string()),
  timezone: v.optional(v.string()),
};

const fetchLocalAgentContextRuntimeArgs = {
  agentType: v.string(),
  runId: v.string(),
  platform: v.optional(v.string()),
  timezone: v.optional(v.string()),
};

const fetchAgentContextForOwner = async (
  ctx: ActionCtx,
  args: FetchAgentContextSharedArgs,
): Promise<AgentContextResult> => {
  // 1. Build system prompt (includes skills, threads, platform, timezone)
  const promptBuild = await buildSystemPrompt(ctx, args.agentType, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    platform: args.platform,
    timezone: args.timezone,
  });

  // 2. Resolve primary/fallback models for the runtime.
  const modelDefaults = getModelConfig(args.agentType);
  let model = modelDefaults.model;
  const override = await ctx.runQuery(
    internal.data.preferences.getPreferenceForOwner,
    { ownerId: args.ownerId, key: `model_config:${args.agentType}` },
  );
  if (typeof override === "string" && override.trim().length > 0) {
    model = override.trim();
  }

  let generalAgentEngine: "default" | "codex_local" | "claude_code_local" | undefined;
  let codexLocalMaxConcurrency: number | undefined;
  if (args.agentType === "general") {
    generalAgentEngine = "default";
    codexLocalMaxConcurrency = DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY;
    const enginePreference = await ctx.runQuery(
      internal.data.preferences.getPreferenceForOwner,
      { ownerId: args.ownerId, key: GENERAL_AGENT_ENGINE_KEY },
    );
    generalAgentEngine = normalizeGeneralAgentEngine(enginePreference);
    const concurrencyPreference = await ctx.runQuery(
      internal.data.preferences.getPreferenceForOwner,
      { ownerId: args.ownerId, key: CODEX_LOCAL_MAX_CONCURRENCY_KEY },
    );
    codexLocalMaxConcurrency = normalizeCodexLocalMaxConcurrency(concurrencyPreference);
  }

  // 3. Get thread history if we have an active thread
  let threadHistory: Array<{ role: string; content: string; toolCallId?: string }> | undefined;
  let activeThreadId: string | undefined;

  const resolvedThreadId = args.threadId ?? await ctx.runQuery(
    internal.conversations.getActiveThreadId,
    { conversationId: args.conversationId },
  );

  if (resolvedThreadId) {
    activeThreadId = resolvedThreadId;
    try {
      const messages = await ctx.runQuery(
        internal.data.threads.loadThreadMessages,
        {
          threadId: resolvedThreadId as Id<"threads">,
        },
      );
      const recent = messages.slice(-(args.maxHistoryMessages ?? 50));
      if (recent.length > 0) {
        threadHistory = recent.map((m: { role: string; content: string; toolCallId?: string }) => ({
          role: m.role,
          content: m.content,
          toolCallId: m.toolCallId,
        }));
      }
    } catch {
      // Thread messages unavailable
    }
  }

  return {
    systemPrompt: promptBuild.systemPrompt,
    dynamicContext: promptBuild.dynamicContext,
    toolsAllowlist: promptBuild.toolsAllowlist,
    model,
    fallbackModel: modelDefaults.fallback,
    maxTaskDepth: promptBuild.maxTaskDepth,
    defaultSkills: promptBuild.defaultSkills,
    skillIds: promptBuild.skillIds,
    threadHistory,
    activeThreadId,
    gatewayApiKey: process.env.AI_GATEWAY_API_KEY,
    generalAgentEngine,
    codexLocalMaxConcurrency,
  };
};

export const fetchAgentContext = internalAction({
  args: fetchAgentContextInternalArgs,
  handler: async (ctx, args): Promise<AgentContextResult> => {
    return await fetchAgentContextForOwner(ctx, args);
  },
});

export const fetchAgentContextForRuntime = action({
  args: fetchAgentContextRuntimeArgs,
  returns: agentContextResultValidator,
  handler: async (ctx, args): Promise<AgentContextResult> => {
    const conversation = await requireConversationOwnerAction(ctx, args.conversationId);
    return await fetchAgentContextForOwner(ctx, {
      ownerId: conversation.ownerId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      runId: args.runId,
      threadId: args.threadId,
      maxHistoryMessages: args.maxHistoryMessages,
      platform: args.platform,
      timezone: args.timezone,
    });
  },
});

export const fetchLocalAgentContextForRuntime = action({
  args: fetchLocalAgentContextRuntimeArgs,
  returns: agentContextResultValidator,
  handler: async (ctx, args): Promise<AgentContextResult> => {
    const ownerId = await requireUserId(ctx);

    const promptBuild = await buildSystemPrompt(ctx, args.agentType, {
      ownerId,
      platform: args.platform,
      timezone: args.timezone,
    });
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
      // Ignore model override lookup errors for local bootstrap.
    }

    let generalAgentEngine: "default" | "codex_local" | "claude_code_local" | undefined;
    let codexLocalMaxConcurrency: number | undefined;
    if (args.agentType === "general") {
      generalAgentEngine = "default";
      codexLocalMaxConcurrency = DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY;
      try {
        const enginePreference = await ctx.runQuery(
          internal.data.preferences.getPreferenceForOwner,
          { ownerId, key: GENERAL_AGENT_ENGINE_KEY },
        );
        generalAgentEngine = normalizeGeneralAgentEngine(enginePreference);
      } catch {
        // Ignore preference lookup errors; defaults remain valid.
      }
      try {
        const concurrencyPreference = await ctx.runQuery(
          internal.data.preferences.getPreferenceForOwner,
          { ownerId, key: CODEX_LOCAL_MAX_CONCURRENCY_KEY },
        );
        codexLocalMaxConcurrency = normalizeCodexLocalMaxConcurrency(concurrencyPreference);
      } catch {
        // Ignore preference lookup errors; defaults remain valid.
      }
    }

    return {
      systemPrompt: promptBuild.systemPrompt,
      dynamicContext: promptBuild.dynamicContext,
      toolsAllowlist: promptBuild.toolsAllowlist,
      model,
      fallbackModel: modelDefaults.fallback,
      maxTaskDepth: promptBuild.maxTaskDepth,
      defaultSkills: promptBuild.defaultSkills,
      skillIds: promptBuild.skillIds,
      threadHistory: undefined,
      activeThreadId: undefined,
      gatewayApiKey: process.env.AI_GATEWAY_API_KEY,
      generalAgentEngine,
      codexLocalMaxConcurrency,
    };
  },
});

export const getGatewayApiKey = internalAction({
  args: {},
  returns: v.string(),
  handler: async () => {
    const key = process.env.AI_GATEWAY_API_KEY;
    if (!key) {
      throw new ConvexError("AI_GATEWAY_API_KEY is not configured");
    }
    return key;
  },
});
