import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { jsonValueValidator } from "./shared_validators";

const canvasStateValidator = v.object({
  _id: v.id("canvas_states"),
  _creationTime: v.number(),
  ownerId: v.string(),
  conversationId: v.id("conversations"),
  component: v.string(),
  tier: v.string(),
  title: v.optional(v.string()),
  data: v.optional(jsonValueValidator),
  url: v.optional(v.string()),
  width: v.optional(v.number()),
  updatedAt: v.number(),
});

/**
 * Get the saved canvas state for a conversation.
 * Returns the most recent canvas state or null.
 */
export const getForConversation = query({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.union(canvasStateValidator, v.null()),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("canvas_states")
      .withIndex("by_owner_conversation", (q) =>
        q.eq("ownerId", "").eq("conversationId", args.conversationId),
      )
      .first();

    // Fallback: query without owner filter since we may not have ownerId
    if (!result) {
      const all = await ctx.db
        .query("canvas_states")
        .withIndex("by_owner_conversation")
        .take(500);
      return (
        all.find((s) => s.conversationId === args.conversationId) ?? null
      );
    }

    return result;
  },
});

/**
 * Save canvas state for a conversation (internal, called by Canvas tool).
 */
export const save = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    component: v.string(),
    tier: v.string(),
    title: v.optional(v.string()),
    data: v.optional(jsonValueValidator),
    url: v.optional(v.string()),
    width: v.optional(v.number()),
  },
  returns: v.id("canvas_states"),
  handler: async (ctx, args) => {
    // Upsert: find existing state for this conversation
    const existing = await ctx.db
      .query("canvas_states")
      .withIndex("by_owner_conversation", (q) =>
        q.eq("ownerId", args.ownerId).eq("conversationId", args.conversationId),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        component: args.component,
        tier: args.tier,
        title: args.title,
        data: args.data,
        url: args.url,
        width: args.width,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("canvas_states", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      component: args.component,
      tier: args.tier,
      title: args.title,
      data: args.data,
      url: args.url,
      width: args.width,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Get saved canvas state (internal, for Canvas tool restore action).
 */
export const getForConversationInternal = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.union(canvasStateValidator, v.null()),
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("canvas_states")
      .withIndex("by_owner_conversation")
      .take(500);
    return (
      results.find((s) => s.conversationId === args.conversationId) ?? null
    );
  },
});

/**
 * Delete saved canvas state for a conversation.
 */
export const remove = internalMutation({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("canvas_states")
      .withIndex("by_owner_conversation")
      .take(500);
    const matching = results.filter(
      (s) => s.conversationId === args.conversationId,
    );
    for (const state of matching) {
      await ctx.db.delete(state._id);
    }
    return null;
  },
});
