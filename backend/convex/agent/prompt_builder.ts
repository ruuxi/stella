import type { ActionCtx, QueryCtx } from "../_generated/server";
import { action, internalAction, internalQuery } from "../_generated/server";
import { Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireConversationOwnerAction, requireUserId } from "../auth";
import {
  GENERAL_AGENT_ENGINE_KEY,
  MAX_AGENT_CONCURRENCY_KEY,
  normalizeGeneralAgentEngine,
  normalizeMaxAgentConcurrency,
} from "../data/preferences";
import { AGENT_IDS } from "../lib/agent_constants";
import { getPlatformSystemGuidance } from "../prompts/index";
import { STELLA_DEFAULT_MODEL } from "../stella_models";
import { resolveAgentConfig } from "./agents";

export type PromptBuildResult = {
  systemPrompt: string;
  dynamicContext: string;
  toolsAllowlist?: string[];
  maxAgentDepth: number;
  timezone: string;
};

type AgentPromptFields = {
  systemPrompt: string;
  toolsAllowlist?: string[];
  maxAgentDepth?: number;
};

const buildAgentPromptContext = (
  agent: AgentPromptFields,
  options?: { platform?: string; timezone?: string },
): Pick<PromptBuildResult, "systemPrompt" | "dynamicContext" | "toolsAllowlist" | "maxAgentDepth" | "timezone"> => {
  const systemParts = [agent.systemPrompt];
  if (options?.platform) {
    const guidance = getPlatformSystemGuidance(options.platform);
    if (guidance) {
      systemParts.push(guidance);
    }
  }

  const maxAgentDepthValue = Number(agent.maxAgentDepth);
  const maxAgentDepth =
    Number.isFinite(maxAgentDepthValue) && maxAgentDepthValue >= 0
      ? Math.floor(maxAgentDepthValue)
      : 2;

  return {
    systemPrompt: systemParts.join("\n\n").trim(),
    dynamicContext: "",
    toolsAllowlist: agent.toolsAllowlist,
    maxAgentDepth,
    timezone: options?.timezone ?? "UTC",
  };
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
  const agent = await ctx.runQuery(
    internal.agent.agents.getAgentConfigInternal,
    {
      agentType,
      ownerId: options?.ownerId,
    },
  );

  return buildAgentPromptContext(agent, options);
};

// fetchAgentContext
// Returns everything the local agent runtime needs in a single round-trip:
// system prompt, dynamic context, tool allowlist,
// thread history, and managed auth context for LLM access.

const agentContextResultValidator = v.object({
  systemPrompt: v.string(),
  dynamicContext: v.string(),
  toolsAllowlist: v.optional(v.array(v.string())),
  model: v.string(),
  maxAgentDepth: v.number(),
  threadHistory: v.optional(
    v.array(
      v.object({
        role: v.string(),
        content: v.string(),
        toolCallId: v.optional(v.string()),
      }),
    ),
  ),
  activeThreadId: v.optional(v.string()),
  agentEngine: v.optional(
    v.union(
      v.literal("default"),
      v.literal("codex_local"),
      v.literal("claude_code_local"),
    ),
  ),
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

/**
 * Cap on thread-history rows returned by `agentRuntimeContext`. Stays well
 * below the array-return limit so a busy thread doesn't fail the bundled
 * read; the `prompt_builder` callers only ever slice the tail anyway.
 */
const AGENT_CONTEXT_THREAD_HISTORY_CAP = 200;

const lookupOwnerPreference = async (
  ctx: QueryCtx,
  ownerId: string,
  key: string,
) => {
  const record = await ctx.db
    .query("user_preferences")
    .withIndex("by_ownerId_and_key", (q) =>
      q.eq("ownerId", ownerId).eq("key", key),
    )
    .unique();
  return record?.value ?? null;
};

const agentRuntimeContextResultValidator = v.object({
  agent: v.object({
    systemPrompt: v.string(),
    toolsAllowlist: v.optional(v.array(v.string())),
    maxAgentDepth: v.optional(v.number()),
  }),
  modelOverride: v.union(v.null(), v.string()),
  agentEngine: v.union(
    v.null(),
    v.literal("default"),
    v.literal("codex_local"),
    v.literal("claude_code_local"),
  ),
  maxAgentConcurrency: v.union(v.null(), v.number()),
  resolvedThreadId: v.union(v.null(), v.id("threads")),
  threadMessages: v.array(
    v.object({
      role: v.string(),
      content: v.string(),
      toolCallId: v.optional(v.string()),
    }),
  ),
});
type AgentRuntimeContextResult = Infer<typeof agentRuntimeContextResultValidator>;

/**
 * Bundled context read for the agent runtime. Replaces the previous fan-out
 * of 3–5 separate `ctx.runQuery` round-trips (agent config + per-key
 * preference lookups + active-thread id + thread messages), which gave
 * inconsistent snapshots when a write interleaved between the calls. A
 * single `internalQuery` is one transaction, so the bundle is internally
 * consistent.
 */
export const agentRuntimeContext = internalQuery({
  args: {
    ownerId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    agentType: v.string(),
    threadId: v.optional(v.id("threads")),
    maxHistoryMessages: v.optional(v.number()),
  },
  returns: agentRuntimeContextResultValidator,
  handler: async (ctx, args): Promise<AgentRuntimeContextResult> => {
    const agent = await resolveAgentConfig(ctx, {
      agentType: args.agentType,
      ownerId: args.ownerId,
    });

    const modelOverrideRaw = await lookupOwnerPreference(
      ctx,
      args.ownerId,
      `model_config:${args.agentType}`,
    );
    const modelOverride =
      typeof modelOverrideRaw === "string" && modelOverrideRaw.trim().length > 0
        ? modelOverrideRaw.trim()
        : null;

    let agentEngine: AgentRuntimeContextResult["agentEngine"] = null;
    let maxAgentConcurrency: AgentRuntimeContextResult["maxAgentConcurrency"] = null;
    if (args.agentType === AGENT_IDS.GENERAL) {
      const [enginePref, concurrencyPref] = await Promise.all([
        lookupOwnerPreference(ctx, args.ownerId, GENERAL_AGENT_ENGINE_KEY),
        lookupOwnerPreference(ctx, args.ownerId, MAX_AGENT_CONCURRENCY_KEY),
      ]);
      agentEngine = normalizeGeneralAgentEngine(enginePref);
      maxAgentConcurrency = normalizeMaxAgentConcurrency(concurrencyPref);
    }

    let resolvedThreadId: Id<"threads"> | null = args.threadId ?? null;
    if (!resolvedThreadId && args.conversationId) {
      const conversation = await ctx.db.get(args.conversationId);
      resolvedThreadId = conversation?.activeThreadId ?? null;
    }

    let threadMessages: AgentRuntimeContextResult["threadMessages"] = [];
    if (resolvedThreadId) {
      const cap = Math.min(
        Math.max(Math.floor(args.maxHistoryMessages ?? 50), 1),
        AGENT_CONTEXT_THREAD_HISTORY_CAP,
      );
      // Read newest-first and reverse so we always return the most recent
      // `cap` messages without scanning a long thread end-to-end.
      const recent = await ctx.db
        .query("thread_messages")
        .withIndex("by_threadId_and_ordinal", (q) =>
          q.eq("threadId", resolvedThreadId!),
        )
        .order("desc")
        .take(cap);
      threadMessages = recent.reverse().map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      }));
    }

    return {
      agent: {
        systemPrompt: agent.systemPrompt,
        toolsAllowlist: agent.toolsAllowlist,
        maxAgentDepth: agent.maxAgentDepth,
      },
      modelOverride,
      agentEngine,
      maxAgentConcurrency,
      resolvedThreadId,
      threadMessages,
    };
  },
});

const fetchAgentContextForOwner = async (
  ctx: ActionCtx,
  args: FetchAgentContextSharedArgs,
): Promise<AgentContextResult> => {
  const bundle: AgentRuntimeContextResult = await ctx.runQuery(
    internal.agent.prompt_builder.agentRuntimeContext,
    {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      threadId: args.threadId,
      maxHistoryMessages: args.maxHistoryMessages,
    },
  );

  const promptContext = buildAgentPromptContext(bundle.agent, {
    platform: args.platform,
    timezone: args.timezone,
  });

  return {
    systemPrompt: promptContext.systemPrompt,
    dynamicContext: promptContext.dynamicContext,
    toolsAllowlist: promptContext.toolsAllowlist,
    model: bundle.modelOverride ?? STELLA_DEFAULT_MODEL,
    maxAgentDepth: promptContext.maxAgentDepth,
    threadHistory: bundle.threadMessages.length > 0 ? bundle.threadMessages : undefined,
    activeThreadId: bundle.resolvedThreadId ?? undefined,
    agentEngine: bundle.agentEngine ?? undefined,
    maxAgentConcurrency: bundle.maxAgentConcurrency ?? undefined,
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
    const conversation = await requireConversationOwnerAction(
      ctx,
      args.conversationId,
    );
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

    const bundle: AgentRuntimeContextResult = await ctx.runQuery(
      internal.agent.prompt_builder.agentRuntimeContext,
      {
        ownerId,
        agentType: args.agentType,
      },
    );

    const promptContext = buildAgentPromptContext(bundle.agent, {
      platform: args.platform,
    });

    return {
      systemPrompt: promptContext.systemPrompt,
      dynamicContext: promptContext.dynamicContext,
      toolsAllowlist: promptContext.toolsAllowlist,
      model: bundle.modelOverride ?? STELLA_DEFAULT_MODEL,
      maxAgentDepth: promptContext.maxAgentDepth,
      threadHistory: undefined,
      activeThreadId: undefined,
      agentEngine: bundle.agentEngine ?? undefined,
      maxAgentConcurrency: bundle.maxAgentConcurrency ?? undefined,
    };
  },
});
