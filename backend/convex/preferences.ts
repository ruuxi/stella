import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireUserId } from "./auth";

export const setPreference = mutation({
  args: {
    key: v.string(),
    value: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", args.key))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.value,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId,
        key: args.key,
        value: args.value,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

export const getPreference = query({
  args: {
    key: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", args.key))
      .first();
    return record?.value ?? null;
  },
});
