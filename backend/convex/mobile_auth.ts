import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
} from "./_generated/server";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

export const createPendingLinkRequest = internalMutation({
  args: {
    email: v.string(),
    requestId: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auth_link_requests", {
      email: args.email,
      requestId: args.requestId,
      status: "pending",
      expiresAt: args.expiresAt,
      createdAt: args.createdAt,
    });
  },
});

export const getLinkRequestStatus = internalQuery({
  args: {
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    if (!REQUEST_ID_PATTERN.test(args.requestId)) {
      return null;
    }
    const record = await ctx.db
      .query("auth_link_requests")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!record) {
      return null;
    }
    if (Date.now() > record.expiresAt) {
      return { status: "expired" as const };
    }
    if (record.status === "completed" && record.ott) {
      return { status: "completed" as const, ott: record.ott };
    }
    return { status: "pending" as const };
  },
});

export const completeLinkRequest = internalMutation({
  args: {
    requestId: v.string(),
    ott: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("auth_link_requests")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!record) {
      return { ok: false, reason: "not_found" };
    }
    if (record.status !== "pending") {
      return { ok: false, reason: "already_completed" };
    }
    if (Date.now() > record.expiresAt) {
      return { ok: false, reason: "expired" };
    }
    await ctx.db.patch(record._id, {
      status: "completed",
      ott: args.ott,
    });
    return { ok: true };
  },
});

export const cleanupLinkRequest = internalMutation({
  args: {
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("auth_link_requests")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (record) {
      await ctx.db.delete(record._id);
    }
  },
});
