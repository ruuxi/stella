import { mutation, internalMutation, internalQuery } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import { v, ConvexError } from "convex/values";
import { requireUserId } from "../auth";
import {
  enforceMutationRateLimit,
  RATE_VERY_EXPENSIVE,
} from "../lib/rate_limits";
import { jsonObjectValidator } from "../shared_validators";
import { internal } from "../_generated/api";


export const listPublicIntegrations = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("integrations_public")
      .withIndex("by_updatedAt")
      .order("desc")
      .take(200);
  },
});

export const upsertPublicIntegration = internalMutation({
  args: {
    id: v.string(),
    provider: v.string(),
    enabled: v.boolean(),
    usagePolicy: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("integrations_public")
      .withIndex("by_integrationId", (q) => q.eq("id", args.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        provider: args.provider,
        enabled: args.enabled,
        usagePolicy: args.usagePolicy,
        updatedAt: Date.now(),
      });
      return null;
    }

    await ctx.db.insert("integrations_public", {
      id: args.id,
      provider: args.provider,
      enabled: args.enabled,
      usagePolicy: args.usagePolicy,
      updatedAt: Date.now(),
    });
    return null;
  },
});

const SLACK_OAUTH_SCOPE = "chat:write,im:history,im:read,im:write";
const SLACK_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/**
 * On every state creation, opportunistically clean up at most this many of
 * the caller's own expired states. Bounded so creation latency stays flat.
 */
const SLACK_OAUTH_EXPIRED_CLEANUP_BATCH = 16;

const generateSecureState = (bytesLength = 24) => {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const hashSha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const createSlackInstallUrl = mutation({
  args: {},
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);

    // Each call writes a `slack_oauth_states` row + crypto + cleanup work.
    // No legitimate UI needs to ask for new install URLs in tight loops.
    await enforceMutationRateLimit(
      ctx,
      "data_create_slack_install_url",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many Slack install requests. Please wait before trying again.",
    );

    const clientId = process.env.SLACK_CLIENT_ID;
    const convexSiteUrl = process.env.CONVEX_SITE_URL;

    if (!clientId || !convexSiteUrl) {
      throw new ConvexError({ code: "INTERNAL_ERROR", message: "Slack OAuth is not configured" });
    }

    const now = Date.now();
    const expiresAt = now + SLACK_OAUTH_STATE_TTL_MS;
    // 24 bytes (192 bits) of entropy — sufficient strength that we can store
    // sha256(state) directly without an additional per-row salt.
    const state = generateSecureState();
    const stateHash = await hashSha256Hex(state);

    // Best-effort cleanup of this owner's expired state rows so the table
    // doesn't accumulate dead nonces. Bounded; any leftovers get caught by
    // the next call or the periodic `purgeExpiredSlackOAuthStates` mutation.
    const expiredOwnRows = await ctx.db
      .query("slack_oauth_states")
      .withIndex("by_ownerId_and_expiresAt", (q) =>
        q.eq("ownerId", ownerId).lt("expiresAt", now),
      )
      .take(SLACK_OAUTH_EXPIRED_CLEANUP_BATCH);
    await Promise.all(expiredOwnRows.map((row) => ctx.db.delete(row._id)));

    await ctx.db.insert("slack_oauth_states", {
      ownerId,
      stateHash,
      expiresAt,
      createdAt: now,
    });

    const redirectUri = `${convexSiteUrl}/api/slack/oauth_callback`;
    const url =
      `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(SLACK_OAUTH_SCOPE)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;

    return { url, expiresAt };
  },
});

export const consumeSlackOAuthState = internalMutation({
  args: {
    state: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const stateHash = await hashSha256Hex(args.state);
    const candidate = await ctx.db
      .query("slack_oauth_states")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", stateHash))
      .unique();

    if (!candidate) return null;
    if (candidate.usedAt !== undefined) return null;
    if (candidate.expiresAt <= now) return null;

    await ctx.db.patch(candidate._id, { usedAt: now });
    return { ownerId: candidate.ownerId };
  },
});

/**
 * Periodic cleanup for expired Slack OAuth state nonces. Returns
 * `hasMore: true` while there are more rows to delete and self-schedules a
 * follow-up via `ctx.scheduler.runAfter(0, ...)` so a single hourly cron tick
 * can drain a large backlog without blowing the per-mutation transaction
 * limits.
 */
export const purgeExpiredSlackOAuthStates = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const batchSize = Math.min(Math.max(Math.floor(args.batchSize ?? 200), 1), 1000);
    const now = Date.now();
    const expired = await ctx.db
      .query("slack_oauth_states")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
    const hasMore = expired.length === batchSize;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.data.integrations.purgeExpiredSlackOAuthStates,
        { batchSize },
      );
    }
    return { deleted: expired.length, hasMore };
  },
});

const getPublicIntegrationByIdHandler = async (ctx: Pick<QueryCtx, "db">, args: { id: string }) => {
  const record = await ctx.db
    .query("integrations_public")
    .withIndex("by_integrationId", (q) => q.eq("id", args.id))
    .unique();
  if (!record || !record.enabled) {
    return null;
  }
  return record;
};


export const getPublicIntegrationById = internalQuery({
  args: {
    id: v.string(),
  },
  handler: async (ctx, args) => {
    return await getPublicIntegrationByIdHandler(ctx, args);
  },
});

export const listUserIntegrations = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);
  },
});

export const upsertUserIntegration = internalMutation({
  args: {
    provider: v.string(),
    mode: v.string(),
    externalId: v.optional(v.string()),
    config: jsonObjectValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    // `(ownerId, provider)` is intended to be unique. `.unique()` throws if
    // that invariant ever breaks, surfacing the bug instead of silently
    // patching one of N duplicate rows.
    const existing = await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", args.provider),
      )
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        mode: args.mode,
        externalId: args.externalId,
        config: args.config,
        updatedAt: now,
      });
      return null;
    }

    await ctx.db.insert("user_integrations", {
      ownerId,
      provider: args.provider,
      mode: args.mode,
      externalId: args.externalId,
      config: args.config,
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});
