import { mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { requireUserId } from "./auth";

export const getById = internalQuery({
  args: { id: v.id("conversations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getOrCreateDefaultConversation = mutation({
  args: {
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_owner_default", (q) =>
        q.eq("ownerId", ownerId).eq("isDefault", true),
      )
      .first();

    if (existing) {
      return existing;
    }

    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      ownerId,
      title: args.title ?? "Default",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get("conversations", id);
  },
});

export const createConversation = mutation({
  args: {
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      ownerId,
      title: args.title ?? "New conversation",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get("conversations", id);
  },
});

export const patchTokenCount = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    tokenDelta: v.number(),
  },
  handler: async (ctx, args) => {
    const delta = Number(args.tokenDelta);
    if (!Number.isFinite(delta) || delta === 0) {
      return;
    }
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      return;
    }
    const prev = conversation.tokenCount ?? 0;
    await ctx.db.patch(args.conversationId, { tokenCount: prev + delta });
  },
});

export const patchLastIngestedAt = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    lastIngestedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      return;
    }
    const prev = conversation.lastIngestedAt ?? 0;
    const next = Math.max(prev, args.lastIngestedAt);
    if (next === prev) {
      return;
    }
    await ctx.db.patch(args.conversationId, { lastIngestedAt: next });
  },
});
