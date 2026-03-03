import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

const OUTBOUND_GC_MAX_AGE_MS = 24 * 60 * 60_000; // 24 hours

export const enqueue = internalMutation({
  args: {
    sessionId: v.id("bridge_sessions"),
    ownerId: v.string(),
    provider: v.string(),
    externalUserId: v.string(),
    text: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("bridge_outbound", {
      sessionId: args.sessionId,
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
      text: args.text,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const claim = internalMutation({
  args: {
    sessionId: v.id("bridge_sessions"),
  },
  returns: v.array(v.object({ externalUserId: v.string(), text: v.string() })),
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("bridge_outbound")
      .withIndex("by_sessionId_and_createdAt", (q) => q.eq("sessionId", args.sessionId))
      .take(50);

    const messages = pending.map((row) => ({
      externalUserId: row.externalUserId,
      text: row.text,
    }));

    for (const row of pending) {
      await ctx.db.delete(row._id);
    }

    return messages;
  },
});

export const gc = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - OUTBOUND_GC_MAX_AGE_MS;
    const stale = await ctx.db
      .query("bridge_outbound")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(200);

    for (const row of stale) {
      await ctx.db.delete(row._id);
    }

    return stale.length;
  },
});
