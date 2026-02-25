import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

const DEFAULT_TTL_MS = 30 * 60 * 1000;

const normalizeTtlMs = (ttlMs?: number) => {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) {
    return DEFAULT_TTL_MS;
  }
  return Math.max(60_000, Math.floor(ttlMs));
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
