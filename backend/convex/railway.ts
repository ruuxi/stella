import { action, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

const notConfigured = () =>
  "Railway integration is not configured. Set STELLAR_RAILWAY_TOKEN and STELLAR_RAILWAY_TEMPLATE_ID.";

export const listRemoteComputers = query({
  args: {
    ownerId: v.string(),
  },
  returns: v.array(
    v.object({
      _id: v.id("remote_computers"),
      ownerId: v.string(),
      railwayServiceId: v.string(),
      domain: v.string(),
      status: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("remote_computers")
      .withIndex("by_owner_and_updated", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(100);
  },
});

export const createRemoteRecord = internalMutation({
  args: {
    ownerId: v.string(),
    railwayServiceId: v.string(),
    domain: v.string(),
    status: v.string(),
  },
  returns: v.id("remote_computers"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("remote_computers", {
      ownerId: args.ownerId,
      railwayServiceId: args.railwayServiceId,
      domain: args.domain,
      status: args.status,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateRemoteStatus = internalMutation({
  args: {
    remoteId: v.id("remote_computers"),
    status: v.string(),
    domain: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.remoteId, {
      status: args.status,
      domain: args.domain,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const deleteRemoteRecord = internalMutation({
  args: {
    remoteId: v.id("remote_computers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete(args.remoteId);
    return null;
  },
});

export const provisionRemote = action({
  args: {
    ownerId: v.string(),
    plan: v.string(),
  },
  returns: v.object({
    status: v.string(),
    message: v.string(),
    remoteId: v.optional(v.id("remote_computers")),
  }),
  handler: async (_ctx, _args) => {
    if (!process.env.STELLAR_RAILWAY_TOKEN || !process.env.STELLAR_RAILWAY_TEMPLATE_ID) {
      return { status: "error", message: notConfigured() };
    }

    return {
      status: "error",
      message: "Railway provisioning is not wired yet.",
    };
  },
});

export const refreshRemoteStatus = action({
  args: {
    ownerId: v.string(),
    remoteId: v.id("remote_computers"),
  },
  returns: v.object({
    status: v.string(),
    message: v.string(),
  }),
  handler: async (_ctx, _args) => {
    if (!process.env.STELLAR_RAILWAY_TOKEN || !process.env.STELLAR_RAILWAY_TEMPLATE_ID) {
      return { status: "error", message: notConfigured() };
    }

    return {
      status: "error",
      message: "Railway status refresh is not wired yet.",
    };
  },
});

export const deprovisionRemote = action({
  args: {
    ownerId: v.string(),
    remoteId: v.id("remote_computers"),
  },
  returns: v.object({
    status: v.string(),
    message: v.string(),
  }),
  handler: async (_ctx, _args) => {
    if (!process.env.STELLAR_RAILWAY_TOKEN || !process.env.STELLAR_RAILWAY_TEMPLATE_ID) {
      return { status: "error", message: notConfigured() };
    }

    return {
      status: "error",
      message: "Railway deprovisioning is not wired yet.",
    };
  },
});

export const normalizeRemoteId = (value: string) => value as Id<"remote_computers">;
