import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";

const deviceRequiredTypes = new Set([
  "user_message",
  "tool_result",
  "screen_event",
]);

export const appendEvent = mutation({
  args: {
    conversationId: v.id("conversations"),
    type: v.string(),
    timestamp: v.optional(v.number()),
    deviceId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    if (deviceRequiredTypes.has(args.type) && !args.deviceId) {
      throw new Error(`deviceId required for ${args.type}`);
    }

    if (args.type === "tool_result" && !args.requestId) {
      throw new Error("tool_result requires requestId");
    }

    const payloadTargetDeviceId =
      args.payload && typeof args.payload === "object"
        ? (args.payload as { targetDeviceId?: string }).targetDeviceId
        : undefined;
    const resolvedTargetDeviceId = args.targetDeviceId ?? payloadTargetDeviceId;

    if (args.type === "tool_request" && !resolvedTargetDeviceId) {
      throw new Error("tool_request requires targetDeviceId");
    }

    const timestamp = args.timestamp ?? Date.now();

    const eventId = await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp,
      type: args.type,
      deviceId: args.deviceId,
      requestId: args.requestId,
      targetDeviceId: resolvedTargetDeviceId,
      payload: args.payload ?? {},
    });

    await ctx.db.patch(args.conversationId, { updatedAt: timestamp });

    return await ctx.db.get("events", eventId);
  },
});

export const listEvents = query({
  args: {
    conversationId: v.id("conversations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("events")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
