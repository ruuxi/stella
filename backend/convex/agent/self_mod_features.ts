import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

export const create = internalMutation({
  args: {
    featureId: v.string(),
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.id("self_mod_features"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("self_mod_features", {
      featureId: args.featureId,
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      name: args.name,
      description: args.description,
      status: "active",
      batchCount: 0,
      files: [],
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = internalMutation({
  args: {
    featureId: v.string(),
    status: v.optional(v.string()),
    batchCount: v.optional(v.number()),
    files: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("self_mod_features")
      .withIndex("by_featureId", (q) => q.eq("featureId", args.featureId))
      .first();

    if (!record) return null;

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.batchCount !== undefined) patch.batchCount = args.batchCount;
    if (args.files !== undefined) patch.files = args.files;

    await ctx.db.patch(record._id, patch);
    return null;
  },
});

export const listForConversation = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.array(
    v.object({
      _id: v.id("self_mod_features"),
      _creationTime: v.number(),
      featureId: v.string(),
      ownerId: v.string(),
      conversationId: v.id("conversations"),
      name: v.string(),
      description: v.optional(v.string()),
      status: v.string(),
      batchCount: v.number(),
      files: v.array(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("self_mod_features")
      .withIndex("by_conversationId_and_timestamp", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .take(100);
  },
});

export const listForOwner = internalQuery({
  args: {
    ownerId: v.string(),
  },
  returns: v.array(
    v.object({
      _id: v.id("self_mod_features"),
      _creationTime: v.number(),
      featureId: v.string(),
      ownerId: v.string(),
      conversationId: v.id("conversations"),
      name: v.string(),
      description: v.optional(v.string()),
      status: v.string(),
      batchCount: v.number(),
      files: v.array(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("self_mod_features")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(100);
  },
});

export const getByFeatureId = internalQuery({
  args: {
    featureId: v.string(),
  },
  returns: v.union(
    v.object({
      _id: v.id("self_mod_features"),
      _creationTime: v.number(),
      featureId: v.string(),
      ownerId: v.string(),
      conversationId: v.id("conversations"),
      name: v.string(),
      description: v.optional(v.string()),
      status: v.string(),
      batchCount: v.number(),
      files: v.array(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("self_mod_features")
      .withIndex("by_featureId", (q) => q.eq("featureId", args.featureId))
      .first();
  },
});
