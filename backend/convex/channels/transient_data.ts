import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { hashSha256Hex } from "../lib/crypto_utils";
import { normalizeOptionalInt } from "../lib/number_utils";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const MIN_TTL_MS = 60_000;
const DEFAULT_CLEANUP_FAILURE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CLEANUP_FAILURE_ERROR_CHARS = 400;
const MAX_PURGE_BATCH_LIMIT = 5_000;

const normalizeTtlMs = (ttlMs?: number) =>
  ttlMs != null
    ? Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(ttlMs)))
    : DEFAULT_TTL_MS;

const toCleanupFailureError = (value?: string): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, MAX_CLEANUP_FAILURE_ERROR_CHARS);
};

export const appendTransientEvent = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    provider: v.string(),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    text: v.string(),
    batchKey: v.string(),
    runId: v.optional(v.string()),
    metadata: v.optional(v.object({
      source: v.optional(v.string()),
      syncMode: v.optional(v.string()),
      fallback: v.optional(v.string()),
    })),
    ttlMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("transient_channel_events", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      provider: args.provider,
      direction: args.direction,
      text: args.text,
      batchKey: args.batchKey,
      runId: args.runId,
      metadata: args.metadata,
      createdAt: now,
      expiresAt: now + normalizeTtlMs(args.ttlMs),
    });
  },
});

export const deleteTransientBatch = internalMutation({
  args: {
    batchKey: v.string(),
  },
  handler: async (ctx, args) => {
    let deleted = 0;
    while (true) {
      const rows = await ctx.db
        .query("transient_channel_events")
        .withIndex("by_batchKey", (q) => q.eq("batchKey", args.batchKey))
        .take(200);
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
      if (rows.length < 200) {
        break;
      }
    }
    return deleted;
  },
});

const normalizePurgeArgs = (args: {
  nowMs?: number;
  limit?: number;
  maxBatches?: number;
}) => ({
  nowMs: args.nowMs ?? Date.now(),
  limit: normalizeOptionalInt({ value: args.limit, defaultValue: 500, min: 1, max: MAX_PURGE_BATCH_LIMIT }),
  maxBatches: normalizeOptionalInt({ value: args.maxBatches, defaultValue: 10, min: 1, max: 50 }),
});

const purgeExpiredByIndex = async (
  ctx: { db: any },
  table: string,
  index: string,
  rawArgs: { nowMs?: number; limit?: number; maxBatches?: number },
) => {
  const { nowMs, limit, maxBatches } = normalizePurgeArgs(rawArgs);
  let deleted = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const expired = await ctx.db
      .query(table)
      .withIndex(index, (q: any) => q.lte("expiresAt", nowMs))
      .take(limit);

    if (expired.length === 0) break;

    for (const row of expired) {
      await ctx.db.delete(row._id);
      deleted += 1;
    }

    if (expired.length < limit) break;
  }
  return deleted;
};

export const purgeExpired = internalMutation({
  args: {
    nowMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    purgeExpiredByIndex(ctx, "transient_channel_events", "by_expiresAt", args),
});

export const recordCleanupFailure = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    provider: v.string(),
    batchKey: v.string(),
    attempts: v.number(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("transient_cleanup_failures", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      provider: args.provider,
      batchKeyHash: await hashSha256Hex(args.batchKey),
      attempts: Math.max(1, Math.floor(args.attempts)),
      errorMessage: toCleanupFailureError(args.errorMessage),
      createdAt: now,
      expiresAt: now + DEFAULT_CLEANUP_FAILURE_RETENTION_MS,
    });
    return null;
  },
});

export const purgeExpiredCleanupFailures = internalMutation({
  args: {
    nowMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    purgeExpiredByIndex(ctx, "transient_cleanup_failures", "by_expiresAt", args),
});
