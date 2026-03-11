import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "../_generated/server";
import { v, ConvexError } from "convex/values";
import { requireUserId } from "../auth";
import { hasModelConfig, listModelDefaults } from "../agent/model";

const accountModeValidator = v.union(v.literal("private_local"), v.literal("connected"));
const ACCOUNT_MODE_KEY = "account_mode";
const syncModeValidator = v.union(v.literal("on"), v.literal("off"));
const SYNC_MODE_KEY = "sync_mode";
const generalAgentEngineValidator = v.union(
  v.literal("default"),
  v.literal("codex_local"),
  v.literal("claude_code_local"),
);
export const GENERAL_AGENT_ENGINE_KEY = "general_agent_engine";
export const CODEX_LOCAL_MAX_CONCURRENCY_KEY = "codex_local_max_concurrency";
export const DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY = 3;
export const MIN_CODEX_LOCAL_MAX_CONCURRENCY = 1;
export const MAX_CODEX_LOCAL_MAX_CONCURRENCY = 3;
export const PREFERRED_BROWSER_KEY = "preferred_browser";
const preferredBrowserValidator = v.union(
  v.literal("arc"),
  v.literal("brave"),
  v.literal("chrome"),
  v.literal("edge"),
  v.literal("firefox"),
  v.literal("opera"),
  v.literal("safari"),
  v.literal("vivaldi"),
  v.literal("none"),
);

const normalizeAccountMode = (
  value: string | null | undefined,
): "private_local" | "connected" => (value === "connected" ? "connected" : "private_local");

export const normalizeSyncMode = (value: string | null | undefined): "on" | "off" =>
  value === "on" ? "on" : "off";

export const normalizeGeneralAgentEngine = (
  value: string | null | undefined,
): "default" | "codex_local" | "claude_code_local" => {
  if (value === "codex_local") return "codex_local";
  if (value === "claude_code_local") return "claude_code_local";
  return "default";
};

export const normalizeCodexLocalMaxConcurrency = (value: string | null | undefined): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY;
  const rounded = Math.floor(parsed);
  return Math.max(
    MIN_CODEX_LOCAL_MAX_CONCURRENCY,
    Math.min(MAX_CODEX_LOCAL_MAX_CONCURRENCY, rounded),
  );
};

export const upsertPreferenceRecord = async (
  ctx: MutationCtx,
  ownerId: string,
  key: string,
  value: string,
) => {
  const existing = await ctx.db
    .query("user_preferences")
    .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      value,
      updatedAt: Date.now(),
    });
    return;
  }

  await ctx.db.insert("user_preferences", {
    ownerId,
    key,
    value,
    updatedAt: Date.now(),
  });
};

export const setPreference = internalMutation({
  args: {
    key: v.string(),
    value: v.string(),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await upsertPreferenceRecord(ctx, ownerId, args.key, args.value);
    return null;
  },
});

export const setPreferenceForOwner = internalMutation({
  args: {
    ownerId: v.string(),
    key: v.string(),
    value: v.string(),
  },
  handler: async (ctx, args) => {
    await upsertPreferenceRecord(ctx, args.ownerId, args.key, args.value);
    return null;
  },
});

export const getPreference = internalQuery({
  args: {
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId).eq("key", args.key))
      .unique();
    return record?.value ?? null;
  },
});

export const getAccountMode = query({
  args: {},
  returns: accountModeValidator,
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return "private_local";
    const ownerId = identity.subject;
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId).eq("key", ACCOUNT_MODE_KEY))
      .unique();
    return normalizeAccountMode(record?.value ?? null);
  },
});

export const setAccountMode = mutation({
  args: {
    mode: accountModeValidator,
  },
  returns: accountModeValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await upsertPreferenceRecord(ctx, ownerId, ACCOUNT_MODE_KEY, args.mode);
    return args.mode;
  },
});

export const getSyncMode = query({
  args: {},
  returns: syncModeValidator,
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return "off";
    const ownerId = identity.subject;
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId).eq("key", SYNC_MODE_KEY))
      .unique();
    return normalizeSyncMode(record?.value ?? null);
  },
});

export const setSyncMode = mutation({
  args: {
    mode: syncModeValidator,
  },
  returns: syncModeValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await upsertPreferenceRecord(ctx, ownerId, SYNC_MODE_KEY, args.mode);
    return args.mode;
  },
});

export const setPreferredBrowser = mutation({
  args: {
    browser: preferredBrowserValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await upsertPreferenceRecord(ctx, ownerId, PREFERRED_BROWSER_KEY, args.browser);

    return null;
  },
});

export const getAccountModeForOwner = internalQuery({
  args: {
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.ownerId).eq("key", ACCOUNT_MODE_KEY))
      .unique();
    return normalizeAccountMode(record?.value ?? null);
  },
});

export const getSyncModeForOwner = internalQuery({
  args: {
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.ownerId).eq("key", SYNC_MODE_KEY))
      .unique();
    return normalizeSyncMode(record?.value ?? null);
  },
});

export const getGeneralAgentEngine = query({
  args: {},
  returns: generalAgentEngineValidator,
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId).eq("key", GENERAL_AGENT_ENGINE_KEY))
      .unique();
    return normalizeGeneralAgentEngine(record?.value ?? null);
  },
});

export const setGeneralAgentEngine = mutation({
  args: {
    engine: generalAgentEngineValidator,
  },
  returns: generalAgentEngineValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await upsertPreferenceRecord(ctx, ownerId, GENERAL_AGENT_ENGINE_KEY, args.engine);
    return args.engine;
  },
});

export const getCodexLocalMaxConcurrency = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) =>
        q.eq("ownerId", ownerId).eq("key", CODEX_LOCAL_MAX_CONCURRENCY_KEY),
      )
      .unique();
    return normalizeCodexLocalMaxConcurrency(record?.value ?? null);
  },
});

export const setCodexLocalMaxConcurrency = mutation({
  args: {
    value: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const normalized = normalizeCodexLocalMaxConcurrency(String(args.value));
    await upsertPreferenceRecord(ctx, ownerId, CODEX_LOCAL_MAX_CONCURRENCY_KEY, String(normalized));
    return normalized;
  },
});

// ---------------------------------------------------------------------------
// Model overrides — stored as user_preferences with key "model_config:{agentType}"
// ---------------------------------------------------------------------------

const MODEL_CONFIG_PREFIX = "model_config:";

export const getModelOverrides = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const records = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId))
      .collect();

    const overrides: Record<string, string> = {};
    for (const record of records) {
      if (record.key.startsWith(MODEL_CONFIG_PREFIX)) {
        const agentType = record.key.slice(MODEL_CONFIG_PREFIX.length);
        if (!hasModelConfig(agentType)) {
          continue;
        }
        overrides[agentType] = record.value;
      }
    }
    return JSON.stringify(overrides);
  },
});

export const getModelDefaults = query({
  args: {},
  returns: v.array(
    v.object({
      agentType: v.string(),
      model: v.string(),
    }),
  ),
  handler: async () => listModelDefaults(),
});

export const setModelOverride = mutation({
  args: {
    agentType: v.string(),
    model: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!hasModelConfig(args.agentType)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Unknown agent type: ${args.agentType}`,
      });
    }
    if (args.model.length > 200) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Model override exceeds maximum allowed length of 200 characters",
      });
    }
    const ownerId = await requireUserId(ctx);
    const key = `${MODEL_CONFIG_PREFIX}${args.agentType}`;
    await upsertPreferenceRecord(ctx, ownerId, key, args.model);
    return null;
  },
});

export const clearModelOverride = mutation({
  args: {
    agentType: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const key = `${MODEL_CONFIG_PREFIX}${args.agentType}`;
    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});

const EXPRESSION_STYLE_KEY = "expression_style";

export const setExpressionStyle = mutation({
  args: {
    style: v.union(v.literal("emoji"), v.literal("none")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await upsertPreferenceRecord(ctx, ownerId, EXPRESSION_STYLE_KEY, args.style);
    return null;
  },
});

export const getPreferenceForOwner = internalQuery({
  args: {
    ownerId: v.string(),
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.ownerId).eq("key", args.key))
      .unique();
    return record?.value ?? null;
  },
});
