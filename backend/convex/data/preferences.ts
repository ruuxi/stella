import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { requireUserId } from "../auth";

const runtimeModeValidator = v.union(v.literal("local"), v.literal("cloud_247"));
const RUNTIME_MODE_KEY = "runtime_mode";
const accountModeValidator = v.union(v.literal("private_local"), v.literal("connected"));
const ACCOUNT_MODE_KEY = "account_mode";
const PREFERRED_BROWSER_KEY = "preferred_browser";
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

const normalizeRuntimeMode = (value: string | null | undefined): "local" | "cloud_247" =>
  value === "cloud_247" ? "cloud_247" : "local";

const normalizeAccountMode = (
  value: string | null | undefined,
): "private_local" | "connected" => (value === "connected" ? "connected" : "private_local");

const upsertPreferenceRecord = async (
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
  returns: v.null(),
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
  returns: v.null(),
  handler: async (ctx, args) => {
    await upsertPreferenceRecord(ctx, args.ownerId, args.key, args.value);
    return null;
  },
});

export const getPreference = internalQuery({
  args: {
    key: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId).eq("key", args.key))
      .unique();
    return record?.value ?? null;
  },
});

export const getRuntimeMode = query({
  args: {},
  returns: runtimeModeValidator,
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId).eq("key", RUNTIME_MODE_KEY))
      .unique();
    return normalizeRuntimeMode(record?.value ?? null);
  },
});

export const getAccountMode = query({
  args: {},
  returns: accountModeValidator,
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
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

export const setRuntimeMode = internalMutation({
  args: {
    mode: runtimeModeValidator,
  },
  returns: runtimeModeValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await upsertPreferenceRecord(ctx, ownerId, RUNTIME_MODE_KEY, args.mode);
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

export const getRuntimeModeForOwner = internalQuery({
  args: {
    ownerId: v.string(),
  },
  returns: runtimeModeValidator,
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.ownerId).eq("key", RUNTIME_MODE_KEY))
      .unique();
    return normalizeRuntimeMode(record?.value ?? null);
  },
});

export const getAccountModeForOwner = internalQuery({
  args: {
    ownerId: v.string(),
  },
  returns: accountModeValidator,
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.ownerId).eq("key", ACCOUNT_MODE_KEY))
      .unique();
    return normalizeAccountMode(record?.value ?? null);
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
        overrides[agentType] = record.value;
      }
    }
    return JSON.stringify(overrides);
  },
});

export const setModelOverride = mutation({
  args: {
    agentType: v.string(),
    model: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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

const CORE_MEMORY_KEY = "core_memory";

export const setCoreMemory = mutation({
  args: {
    content: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await upsertPreferenceRecord(ctx, ownerId, CORE_MEMORY_KEY, args.content);
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
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.ownerId).eq("key", args.key))
      .unique();
    return record?.value ?? null;
  },
});
