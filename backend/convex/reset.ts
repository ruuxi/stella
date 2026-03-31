import {
  action,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireUserId } from "./auth";

const BATCH = 500;

// ---------------------------------------------------------------------------
// Public action - orchestrates full user data reset across multiple mutations
// ---------------------------------------------------------------------------

export const resetAllUserData = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);

    // 1. Collect conversation IDs
    const conversationIds: Id<"conversations">[] = await ctx.runQuery(
      internal.reset._getConversationIds,
      { ownerId },
    );

    // 2. Delete per-conversation data (events, threads+messages)
    for (const conversationId of conversationIds) {
      let hasMore = true;
      while (hasMore) {
        const result: boolean = await ctx.runMutation(
          internal.reset._deleteConversationBatch,
          { conversationId },
        );
        hasMore = result;
      }
    }

    // 3. Delete owner-scoped tables (prefs, devices, etc.)
    let hasMore = true;
    while (hasMore) {
      const result: boolean = await ctx.runMutation(internal.reset._deleteOwnerBatch, {
        ownerId,
      });
      hasMore = result;
    }

    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export const _getConversationIds = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .collect();
    return conversations.map((c) => c._id);
  },
});

export const _deleteConversationBatch = internalMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    let deleted = 0;

    // Events
    const events = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    await Promise.all(events.map((e) => ctx.db.delete(e._id)));
    deleted += events.length;

    // Threads + their messages
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_conversationId_and_lastUsedAt", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    for (const t of threads) {
      const msgs = await ctx.db
        .query("thread_messages")
        .withIndex("by_threadId_and_ordinal", (q) => q.eq("threadId", t._id))
        .take(BATCH);
      await Promise.all(msgs.map((m) => ctx.db.delete(m._id)));
      deleted += msgs.length;
      
      // Only delete the thread once all its messages are gone
      if (msgs.length < BATCH) {
        await ctx.db.delete(t._id);
        deleted++;
      }
    }

    // When all linked data is gone, delete the conversation itself
    if (events.length === 0 && threads.length === 0) {
      const conv = await ctx.db.get(conversationId);
      if (conv) await ctx.db.delete(conversationId);
      return false;
    }

    return true;
  },
});

export const _deleteOwnerBatch = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, { ownerId }) => {
    let totalDeleted = 0;

    // User preferences
    const prefs = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId))
      .take(BATCH);
    await Promise.all(prefs.map((p) => ctx.db.delete(p._id)));
    totalDeleted += prefs.length;

    // Devices
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(BATCH);
    await Promise.all(devices.map((d) => ctx.db.delete(d._id)));
    totalDeleted += devices.length;

    // Cloudflare tunnels (per desktop)
    const tunnels = await ctx.db
      .query("cloudflare_tunnels")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(BATCH);
    await Promise.all(tunnels.map((t) => ctx.db.delete(t._id)));
    totalDeleted += tunnels.length;

    return totalDeleted > 0;
  },
});
