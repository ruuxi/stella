import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "../_generated/server";
import { v, ConvexError } from "convex/values";
import { requireUserId } from "../auth";
import {
  enforceMutationRateLimit,
  RATE_SETTINGS,
} from "../lib/rate_limits";

/**
 * Shared per-owner cap for every settings mutation in this file. Settings
 * toggles aren't a hot path, so we want any single user to be unable to
 * churn more than ~one update per second.
 */
const PREFERENCE_RATE_SCOPE = "user_preferences_set";
const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
]);

const accountModeValidator = v.union(v.literal("private_local"), v.literal("connected"));
const ACCOUNT_MODE_KEY = "account_mode";
const syncModeValidator = v.union(v.literal("on"), v.literal("off"));
const SYNC_MODE_KEY = "sync_mode";
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
    const ownerId = identity.tokenIdentifier;
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
    await enforceMutationRateLimit(ctx, PREFERENCE_RATE_SCOPE, ownerId, RATE_SETTINGS);
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
    const ownerId = identity.tokenIdentifier;
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
    await enforceMutationRateLimit(ctx, PREFERENCE_RATE_SCOPE, ownerId, RATE_SETTINGS);
    if (args.mode === "on") {
      const billingProfile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique();
      if (
        !billingProfile
        || billingProfile.activePlan === "free"
        || !ACTIVE_SUBSCRIPTION_STATUSES.has(billingProfile.subscriptionStatus)
      ) {
        throw new ConvexError({
          code: "SUBSCRIPTION_REQUIRED",
          message: "Backups require an active Stella subscription.",
        });
      }
    }
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
    await enforceMutationRateLimit(ctx, PREFERENCE_RATE_SCOPE, ownerId, RATE_SETTINGS);
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

const EXPRESSION_STYLE_KEY = "expression_style";

export const setExpressionStyle = mutation({
  args: {
    style: v.union(v.literal("emoji"), v.literal("none")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(ctx, PREFERENCE_RATE_SCOPE, ownerId, RATE_SETTINGS);
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
