import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { requireUserId } from "../auth";

const runtimeModeValidator = v.union(v.literal("local"), v.literal("cloud_247"));
const RUNTIME_MODE_KEY = "runtime_mode";

const normalizeRuntimeMode = (value: string | null | undefined): "local" | "cloud_247" =>
  value === "cloud_247" ? "cloud_247" : "local";

export const setPreference = mutation({
  args: {
    key: v.string(),
    value: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", args.key))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.value,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId,
        key: args.key,
        value: args.value,
        updatedAt: Date.now(),
      });
    }
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
    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", args.ownerId).eq("key", args.key))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.value,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId: args.ownerId,
        key: args.key,
        value: args.value,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

export const getPreference = query({
  args: {
    key: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", args.key))
      .first();
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
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", RUNTIME_MODE_KEY))
      .first();
    return normalizeRuntimeMode(record?.value ?? null);
  },
});

export const setRuntimeMode = mutation({
  args: {
    mode: runtimeModeValidator,
  },
  returns: runtimeModeValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", RUNTIME_MODE_KEY))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.mode,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId,
        key: RUNTIME_MODE_KEY,
        value: args.mode,
        updatedAt: Date.now(),
      });
    }
    return args.mode;
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
      .withIndex("by_owner_key", (q) => q.eq("ownerId", args.ownerId).eq("key", RUNTIME_MODE_KEY))
      .first();
    return normalizeRuntimeMode(record?.value ?? null);
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
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId))
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
    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.model,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId,
        key,
        value: args.model,
        updatedAt: Date.now(),
      });
    }
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
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
      .first();

    if (existing) {
      await ctx.db.delete(existing._id);
    }
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
      .withIndex("by_owner_key", (q) => q.eq("ownerId", args.ownerId).eq("key", args.key))
      .first();
    return record?.value ?? null;
  },
});
