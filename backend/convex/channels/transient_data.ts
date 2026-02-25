import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const MIN_TTL_MS = 60_000;
const DEFAULT_CLEANUP_FAILURE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CLEANUP_FAILURE_ERROR_CHARS = 400;

const normalizeTtlMs = (ttlMs?: number) => {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) {
    return DEFAULT_TTL_MS;
  }
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(ttlMs)));
};

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

const hashSha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
      runtimeMode: v.optional(v.string()),
      fallback: v.optional(v.string()),
    })),
    ttlMs: v.optional(v.number()),
  },
  returns: v.id("transient_channel_events"),
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
  returns: v.number(),
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

export const purgeExpired = internalMutation({
  args: {
    nowMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const nowMs = typeof args.nowMs === "number" ? args.nowMs : Date.now();
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(5_000, Math.floor(args.limit)))
        : 500;
    const maxBatches =
      typeof args.maxBatches === "number" && Number.isFinite(args.maxBatches)
        ? Math.max(1, Math.min(50, Math.floor(args.maxBatches)))
        : 10;

    let deleted = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      const expired = await ctx.db
        .query("transient_channel_events")
        .withIndex("by_expiresAt", (q) => q.lte("expiresAt", nowMs))
        .take(limit);

      if (expired.length === 0) {
        break;
      }

      for (const row of expired) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }

      if (expired.length < limit) {
        break;
      }
    }
    return deleted;
  },
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
  returns: v.null(),
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
  returns: v.number(),
  handler: async (ctx, args) => {
    const nowMs = typeof args.nowMs === "number" ? args.nowMs : Date.now();
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(5_000, Math.floor(args.limit)))
        : 500;
    const maxBatches =
      typeof args.maxBatches === "number" && Number.isFinite(args.maxBatches)
        ? Math.max(1, Math.min(50, Math.floor(args.maxBatches)))
        : 10;

    let deleted = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      const expired = await ctx.db
        .query("transient_cleanup_failures")
        .withIndex("by_expiresAt", (q) => q.lte("expiresAt", nowMs))
        .take(limit);

      if (expired.length === 0) {
        break;
      }

      for (const row of expired) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }

      if (expired.length < limit) {
        break;
      }
    }
    return deleted;
  },
});
