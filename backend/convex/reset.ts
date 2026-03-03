import {
  action,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
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
    const conversationIds = await ctx.runQuery(
      internal.reset._getConversationIds,
      { ownerId },
    );

    // 2. Delete per-conversation data (events, threads+messages, tasks)
    for (const conversationId of conversationIds) {
      let hasMore = true;
      while (hasMore) {
        hasMore = await ctx.runMutation(
          internal.reset._deleteConversationBatch,
          { conversationId },
        );
      }
    }

    // 3. Delete owner-scoped tables (memories, prefs, devices, etc.)
    let hasMore = true;
    while (hasMore) {
      hasMore = await ctx.runMutation(internal.reset._deleteOwnerBatch, {
        ownerId,
      });
    }

    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export const _getConversationIds = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.id("conversations")),
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
  returns: v.boolean(),
  handler: async (ctx, { conversationId }) => {
    let deleted = 0;

    // Events
    const events = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    for (const e of events) {
      await ctx.db.delete(e._id);
      deleted++;
    }

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
      for (const m of msgs) {
        await ctx.db.delete(m._id);
        deleted++;
      }
      // Only delete the thread once all its messages are gone
      if (msgs.length < BATCH) {
        await ctx.db.delete(t._id);
        deleted++;
      }
    }

    // Tasks
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_conversationId_and_createdAt", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    for (const t of tasks) {
      await ctx.db.delete(t._id);
      deleted++;
    }

    // When all linked data is gone, delete the conversation itself
    if (events.length === 0 && threads.length === 0 && tasks.length === 0) {
      const conv = await ctx.db.get(conversationId);
      if (conv) await ctx.db.delete(conversationId);
      return false;
    }

    return true;
  },
});

export const _deleteOwnerBatch = internalMutation({
  args: { ownerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { ownerId }) => {
    let totalDeleted = 0;

    // Memories
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_ownerId_and_accessedAt", (q) => q.eq("ownerId", ownerId))
      .take(BATCH);
    for (const m of memories) {
      await ctx.db.delete(m._id);
      totalDeleted++;
    }

    // Event embeddings
    const eventEmbeddings = await ctx.db
      .query("event_embeddings")
      .withIndex("by_ownerId_and_timestamp", (q) => q.eq("ownerId", ownerId))
      .take(BATCH);
    for (const embedding of eventEmbeddings) {
      await ctx.db.delete(embedding._id);
      totalDeleted++;
    }

    // User preferences
    const prefs = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId))
      .take(BATCH);
    for (const p of prefs) {
      await ctx.db.delete(p._id);
      totalDeleted++;
    }

    // Devices
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(BATCH);
    for (const d of devices) {
      await ctx.db.delete(d._id);
      totalDeleted++;
    }

    // Cloud devices
    const cloudDevices = await ctx.db
      .query("cloud_devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(BATCH);
    for (const cd of cloudDevices) {
      await ctx.db.delete(cd._id);
      totalDeleted++;
    }

    // Bridge outbound (must delete before sessions)
    const bridgeSessions = await ctx.db
      .query("bridge_sessions")
      .withIndex("by_ownerId_and_provider", (q) => q.eq("ownerId", ownerId))
      .take(BATCH);
    for (const bs of bridgeSessions) {
      const outbound = await ctx.db
        .query("bridge_outbound")
        .withIndex("by_sessionId_and_createdAt", (q) => q.eq("sessionId", bs._id))
        .take(BATCH);
      for (const o of outbound) {
        await ctx.db.delete(o._id);
        totalDeleted++;
      }
      // Only delete session once all its outbound messages are gone
      if (outbound.length < BATCH) {
        await ctx.db.delete(bs._id);
        totalDeleted++;
      }
    }

    return totalDeleted > 0;
  },
});
