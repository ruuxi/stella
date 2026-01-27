import { paginationOptsValidator } from "convex/server";
import { mutation, query, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const getById = internalQuery({
  args: { id: v.id("events") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const saveAssistantMessage = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    text: v.string(),
    userMessageId: v.id("events"),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    const eventId = await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp,
      type: "assistant_message",
      payload: {
        text: args.text,
        userMessageId: args.userMessageId,
      },
    });
    await ctx.db.patch(args.conversationId, { updatedAt: timestamp });
    return eventId;
  },
});

export const enqueueToolRequest = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    requestId: v.string(),
    targetDeviceId: v.string(),
    toolName: v.string(),
    toolArgs: v.any(),
    sourceDeviceId: v.optional(v.string()),
    userMessageId: v.optional(v.id("events")),
    agentType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    const eventId = await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp,
      type: "tool_request",
      requestId: args.requestId,
      targetDeviceId: args.targetDeviceId,
      deviceId: args.sourceDeviceId,
      payload: {
        toolName: args.toolName,
        args: args.toolArgs ?? {},
        targetDeviceId: args.targetDeviceId,
        sourceDeviceId: args.sourceDeviceId,
        userMessageId: args.userMessageId,
        agentType: args.agentType,
      },
    });
    await ctx.db.patch(args.conversationId, { updatedAt: timestamp });
    return await ctx.db.get("events", eventId);
  },
});

export const getToolResultByRequestId = internalQuery({
  args: {
    requestId: v.string(),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("events")
      .withIndex("by_request", (q) => q.eq("requestId", args.requestId))
      .order("desc")
      .take(20);
    return (
      results.find((event) => {
        if (event.type !== "tool_result") {
          return false;
        }
        if (args.deviceId && event.deviceId !== args.deviceId) {
          return false;
        }
        return true;
      }) ?? null
    );
  },
});

export const getToolResult = query({
  args: {
    requestId: v.string(),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("events")
      .withIndex("by_request", (q) => q.eq("requestId", args.requestId))
      .order("desc")
      .take(20);
    return (
      results.find((event) => {
        if (event.type !== "tool_result") {
          return false;
        }
        if (args.deviceId && event.deviceId !== args.deviceId) {
          return false;
        }
        return true;
      }) ?? null
    );
  },
});

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

export const listToolRequestsForDevice = query({
  args: {
    deviceId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_target_device", (q) => q.eq("targetDeviceId", args.deviceId))
      .order("desc")
      .paginate(args.paginationOpts);

    const filtered = page.page.filter((event) => {
      if (event.type !== "tool_request") {
        return false;
      }
      if (args.conversationId && event.conversationId !== args.conversationId) {
        return false;
      }
      return true;
    });

    return {
      ...page,
      page: filtered,
    };
  },
});
