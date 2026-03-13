import type { ActionCtx } from "../_generated/server";
import { action, internalAction } from "../_generated/server";
import { Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction, requireUserId } from "../auth";
import {
  GENERAL_AGENT_ENGINE_KEY,
  MAX_AGENT_CONCURRENCY_KEY,
  SELF_MOD_AGENT_ENGINE_KEY,
  normalizeGeneralAgentEngine,
  normalizeMaxAgentConcurrency,
} from "../data/preferences";
import { SKILLS_DISABLED_AGENT_TYPES } from "../lib/agent_constants";
import {
  buildSkillsPromptSection,
  getPlatformSystemGuidance,
} from "../prompts/index";
import { STELLA_DEFAULT_MODEL } from "../stella_models";

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
  maxTaskDepth: v.number(),
  defaultSkills: v.array(v.string()),
  skillIds: v.array(v.string()),
  threadHistory: v.optional(v.array(v.object({
    role: v.string(),
    content: v.string(),
    toolCallId: v.optional(v.string()),
  }))),
  activeThreadId: v.optional(v.string()),
  agentEngine: v.optional(v.union(
    v.literal("default"),
    v.literal("codex_local"),
    v.literal("claude_code_local"),
  )),
  maxAgentConcurrency: v.optional(v.number()),
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
  let model = STELLA_DEFAULT_MODEL;
  const override = await ctx.runQuery(
    internal.data.preferences.getPreferenceForOwner,
    { ownerId: args.ownerId, key: `model_config:${args.agentType}` },
  );
  if (typeof override === "string" && override.trim().length > 0) {
    model = override.trim();
  }

  let agentEngine: "default" | "codex_local" | "claude_code_local" | undefined;
  let maxAgentConcurrency: number | undefined;
  if (args.agentType === "general" || args.agentType === "self_mod") {
    const engineKey = args.agentType === "self_mod"
      ? SELF_MOD_AGENT_ENGINE_KEY
      : GENERAL_AGENT_ENGINE_KEY;
    agentEngine = "default";
    maxAgentConcurrency = 24;
    const enginePreference = await ctx.runQuery(
      internal.data.preferences.getPreferenceForOwner,
      { ownerId: args.ownerId, key: engineKey },
    );
    agentEngine = normalizeGeneralAgentEngine(enginePreference);
    const concurrencyPreference = await ctx.runQuery(
      internal.data.preferences.getPreferenceForOwner,
      { ownerId: args.ownerId, key: MAX_AGENT_CONCURRENCY_KEY },
    );
    maxAgentConcurrency = normalizeMaxAgentConcurrency(concurrencyPreference);
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
    maxTaskDepth: promptBuild.maxTaskDepth,
    defaultSkills: promptBuild.defaultSkills,
    skillIds: promptBuild.skillIds,
    threadHistory,
    activeThreadId,
    agentEngine,
    maxAgentConcurrency,
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
    let model = STELLA_DEFAULT_MODEL;
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

    let agentEngine: "default" | "codex_local" | "claude_code_local" | undefined;
    let maxAgentConcurrency: number | undefined;
    if (args.agentType === "general" || args.agentType === "self_mod") {
      const engineKey = args.agentType === "self_mod"
        ? SELF_MOD_AGENT_ENGINE_KEY
        : GENERAL_AGENT_ENGINE_KEY;
      agentEngine = "default";
      maxAgentConcurrency = 24;
      try {
        const enginePreference = await ctx.runQuery(
          internal.data.preferences.getPreferenceForOwner,
          { ownerId, key: engineKey },
        );
        agentEngine = normalizeGeneralAgentEngine(enginePreference);
      } catch {
        // Ignore preference lookup errors; defaults remain valid.
      }
      try {
        const concurrencyPreference = await ctx.runQuery(
          internal.data.preferences.getPreferenceForOwner,
          { ownerId, key: MAX_AGENT_CONCURRENCY_KEY },
        );
        maxAgentConcurrency = normalizeMaxAgentConcurrency(concurrencyPreference);
      } catch {
        // Ignore preference lookup errors; defaults remain valid.
      }
    }

    return {
      systemPrompt: promptBuild.systemPrompt,
      dynamicContext: promptBuild.dynamicContext,
      toolsAllowlist: promptBuild.toolsAllowlist,
      model,
      maxTaskDepth: promptBuild.maxTaskDepth,
      defaultSkills: promptBuild.defaultSkills,
      skillIds: promptBuild.skillIds,
      threadHistory: undefined,
      activeThreadId: undefined,
      agentEngine,
      maxAgentConcurrency,
    };
  },
});
