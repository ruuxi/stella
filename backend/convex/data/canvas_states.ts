import { query, internalMutation, internalQuery } from "../_generated/server";
import { ConvexError, v } from "convex/values";
import { requireUserId } from "../auth";

const canvasStateValidator = v.object({
  _id: v.id("canvas_states"),
  _creationTime: v.number(),
  ownerId: v.string(),
  conversationId: v.id("conversations"),
  name: v.string(),
  title: v.optional(v.string()),
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
    const ownerId = await requireUserId(ctx);
    const result = await ctx.db
      .query("canvas_states")
      .withIndex("by_ownerId_and_conversationId", (q) =>
        q.eq("ownerId", ownerId).eq("conversationId", args.conversationId),
      )
      .unique();
    return result ?? null;
  },
});

/**
 * Save canvas state for a conversation.
 */
export const save = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    name: v.string(),
    title: v.optional(v.string()),
    url: v.optional(v.string()),
    width: v.optional(v.number()),
  },
  returns: v.id("canvas_states"),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Conversation not found",
      });
    }
    if (conversation.ownerId !== args.ownerId) {
      throw new ConvexError({
        code: "FORBIDDEN",
        message: "Conversation owner mismatch",
      });
    }

    // Upsert: find existing state for this conversation
    const existing = await ctx.db
      .query("canvas_states")
      .withIndex("by_ownerId_and_conversationId", (q) =>
        q.eq("ownerId", args.ownerId).eq("conversationId", args.conversationId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        title: args.title,
        url: args.url,
        width: args.width,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("canvas_states", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      name: args.name,
      title: args.title,
      url: args.url,
      width: args.width,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Get saved canvas state (internal).
 */
export const getForConversationInternal = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.union(canvasStateValidator, v.null()),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      return null;
    }

    return await ctx.db
      .query("canvas_states")
      .withIndex("by_ownerId_and_conversationId", (q) =>
        q
          .eq("ownerId", conversation.ownerId)
          .eq("conversationId", args.conversationId),
      )
      .unique();
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
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      return null;
    }

    const states = await ctx.db
      .query("canvas_states")
      .withIndex("by_ownerId_and_conversationId", (q) =>
        q
          .eq("ownerId", conversation.ownerId)
          .eq("conversationId", args.conversationId),
      )
      .collect();

    for (const state of states) {
      await ctx.db.delete(state._id);
    }
    return null;
  },
});
