import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireUserId } from "./auth";

export const listPublicIntegrations = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("integrations_public"),
      id: v.string(),
      provider: v.string(),
      enabled: v.boolean(),
      usagePolicy: v.string(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    return await ctx.db.query("integrations_public").take(200);
  },
});

export const upsertPublicIntegration = mutation({
  args: {
    id: v.string(),
    provider: v.string(),
    enabled: v.boolean(),
    usagePolicy: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("integrations_public")
      .withIndex("by_integration_id", (q) => q.eq("id", args.id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        provider: args.provider,
        enabled: args.enabled,
        usagePolicy: args.usagePolicy,
        updatedAt: Date.now(),
      });
      return null;
    }

    await ctx.db.insert("integrations_public", {
      id: args.id,
      provider: args.provider,
      enabled: args.enabled,
      usagePolicy: args.usagePolicy,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const listUserIntegrations = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("user_integrations"),
      ownerId: v.string(),
      provider: v.string(),
      mode: v.string(),
      externalId: v.optional(v.string()),
      config: v.any(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await ctx.db
      .query("user_integrations")
      .withIndex("by_owner_and_updated", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);
  },
});

export const upsertUserIntegration = mutation({
  args: {
    provider: v.string(),
    mode: v.string(),
    externalId: v.optional(v.string()),
    config: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("user_integrations")
      .withIndex("by_owner_and_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", args.provider),
      )
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        mode: args.mode,
        externalId: args.externalId,
        config: args.config,
        updatedAt: now,
      });
      return null;
    }

    await ctx.db.insert("user_integrations", {
      ownerId,
      provider: args.provider,
      mode: args.mode,
      externalId: args.externalId,
      config: args.config,
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});
