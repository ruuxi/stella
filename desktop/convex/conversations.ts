import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const getOrCreateDefaultConversation = mutation({
  args: {
    ownerId: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_owner_default", (q) =>
        q.eq("ownerId", args.ownerId).eq("isDefault", true),
      )
      .first();

    if (existing) {
      return existing;
    }

    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      ownerId: args.ownerId,
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
    ownerId: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      ownerId: args.ownerId,
      title: args.title ?? "New conversation",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get("conversations", id);
  },
});
