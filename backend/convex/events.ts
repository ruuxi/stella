import { paginationOptsValidator } from "convex/server";
import { mutation, query, internalQuery, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireConversationOwner, requireUserId } from "./auth";
import { jsonValueValidator } from "./shared_validators";
import {
  sanitizeForToolResultPersistence,
  sanitizeForToolRequestPersistence,
  sanitizeSensitiveData,
} from "./lib/redaction";
import {
  estimateContextEventTokens,
  selectRecentByTokenBudget,
} from "./agent/context_window";

const eventValidator = v.object({
  _id: v.id("events"),
  _creationTime: v.number(),
  conversationId: v.id("conversations"),
  timestamp: v.number(),
  type: v.string(),
  deviceId: v.optional(v.string()),
  requestId: v.optional(v.string()),
  targetDeviceId: v.optional(v.string()),
  payload: jsonValueValidator,
});

const usageSummaryValidator = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
});

const sanitizeEventPayloadForStorage = (type: string, payload: unknown) => {
  if (type === "tool_result") {
    return sanitizeForToolResultPersistence(payload);
  }
  if (type === "tool_request") {
    return sanitizeForToolRequestPersistence(payload);
  }
  return payload;
};

const sanitizeEventPayloadForRead = (type: string, payload: unknown) => {
  if (type === "tool_request" || type === "tool_result") {
    return sanitizeSensitiveData(payload, { redactFreeformStrings: true });
  }
  return payload;
};

const sanitizeEventForRead = <T extends { type: string; payload: unknown } | null>(
  event: T,
): T => {
  if (!event) {
    return event;
  }
  return {
    ...event,
    payload: sanitizeEventPayloadForRead(event.type, event.payload ?? {}),
  } as T;
};

export const countByConversation = internalQuery({
  args: { conversationId: v.id("conversations") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .take(10000);
    return events.length;
  },
});

export const listOlderMessages = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    beforeTimestamp: v.number(),
    afterTimestamp: v.optional(v.number()),
    limit: v.number(),
  },
  returns: v.array(eventValidator),
  handler: async (ctx, args) => {
    const afterTs = args.afterTimestamp ?? 0;
    // Use index range to start scanning from afterTimestamp, up to beforeTimestamp.
    // The by_conversation index is ["conversationId", "timestamp"], so we can
    // bound the timestamp range efficiently.
    const events = await ctx.db
      .query("events")
      .withIndex("by_conversation", (q) =>
        q
          .eq("conversationId", args.conversationId)
          .gt("timestamp", afterTs)
          .lt("timestamp", args.beforeTimestamp),
      )
      .order("asc")
      .take(args.limit * 3);

    return events
      .filter(
        (e) => e.type === "user_message" || e.type === "assistant_message",
      )
      .slice(0, args.limit);
  },
});

export const getById = internalQuery({
  args: { id: v.id("events") },
  returns: v.union(eventValidator, v.null()),
  handler: async (ctx, args) => {
    return sanitizeEventForRead(await ctx.db.get(args.id));
  },
});

export const listRecentMessages = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
    beforeTimestamp: v.optional(v.number()),
    excludeEventId: v.optional(v.id("events")),
  },
  returns: v.array(eventValidator),
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? 20;
    if (requestedLimit <= 0) {
      return [];
    }
    const limit = Math.min(Math.floor(requestedLimit), 100);
    const take = Math.min(Math.max(limit * 3, 50), 200);

    const [userEvents, assistantEvents] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_conversation_type", (q) =>
          q.eq("conversationId", args.conversationId).eq("type", "user_message"),
        )
        .order("desc")
        .take(take),
      ctx.db
        .query("events")
        .withIndex("by_conversation_type", (q) =>
          q.eq("conversationId", args.conversationId).eq("type", "assistant_message"),
        )
        .order("desc")
        .take(take),
    ]);

    let combined = [...userEvents, ...assistantEvents];

    if (args.beforeTimestamp !== undefined) {
      combined = combined.filter((event) => event.timestamp <= args.beforeTimestamp!);
    }
    if (args.excludeEventId) {
      combined = combined.filter((event) => event._id !== args.excludeEventId);
    }

    combined.sort(
      (a, b) =>
        a.timestamp - b.timestamp || String(a._id).localeCompare(String(b._id)),
    );

    if (combined.length > limit) {
      combined = combined.slice(-limit);
    }

    return combined;
  },
});

const MODEL_CONTEXT_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
  "tool_request",
  "tool_result",
  "task_started",
  "task_completed",
  "task_failed",
]);

export const listRecentContextEvents = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
    beforeTimestamp: v.optional(v.number()),
    excludeEventId: v.optional(v.id("events")),
  },
  returns: v.array(eventValidator),
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? 20;
    if (requestedLimit <= 0) {
      return [];
    }
    const limit = Math.min(Math.floor(requestedLimit), 120);
    const take = Math.min(Math.max(limit * 8, 80), 800);

    const query = ctx.db.query("events").withIndex("by_conversation", (q) => {
      const base = q.eq("conversationId", args.conversationId);
      if (args.beforeTimestamp !== undefined) {
        return base.lte("timestamp", args.beforeTimestamp);
      }
      return base;
    });
    let events = await query.order("desc").take(take);

    if (args.excludeEventId) {
      events = events.filter((event) => event._id !== args.excludeEventId);
    }

    events = events.filter((event) => MODEL_CONTEXT_EVENT_TYPES.has(event.type));
    events.sort(
      (a, b) =>
        a.timestamp - b.timestamp || String(a._id).localeCompare(String(b._id)),
    );

    if (events.length > limit) {
      events = events.slice(-limit);
    }

    return events.map((event) => sanitizeEventForRead(event));
  },
});

export const listRecentContextEventsByTokens = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    maxTokens: v.optional(v.number()),
    beforeTimestamp: v.optional(v.number()),
    excludeEventId: v.optional(v.id("events")),
  },
  returns: v.array(eventValidator),
  handler: async (ctx, args) => {
    const maxTokens = Math.min(
      Math.max(Math.floor(args.maxTokens ?? 24_000), 1),
      120_000,
    );
    // Approximate how many recent rows we may need to cover maxTokens.
    // Clamp for predictable query cost.
    const scanLimit = Math.min(
      Math.max(Math.ceil(maxTokens / 6), 240),
      2400,
    );

    const query = ctx.db.query("events").withIndex("by_conversation", (q) => {
      const base = q.eq("conversationId", args.conversationId);
      if (args.beforeTimestamp !== undefined) {
        return base.lte("timestamp", args.beforeTimestamp);
      }
      return base;
    });

    let events = await query.order("desc").take(scanLimit);
    if (args.excludeEventId) {
      events = events.filter((event) => event._id !== args.excludeEventId);
    }

    const modelEvents = events.filter((event) => MODEL_CONTEXT_EVENT_TYPES.has(event.type));
    const selectedNewestFirst = selectRecentByTokenBudget({
      itemsNewestFirst: modelEvents,
      maxTokens,
      estimateTokens: (event) =>
        estimateContextEventTokens({
          type: event.type,
          payload: event.payload,
          requestId: event.requestId,
        }),
    });

    selectedNewestFirst.sort(
      (a, b) =>
        a.timestamp - b.timestamp || String(a._id).localeCompare(String(b._id)),
    );

    return selectedNewestFirst.map((event) => sanitizeEventForRead(event));
  },
});

export const getLatestDeviceIdForConversation = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_conversation_type", (q) =>
        q.eq("conversationId", args.conversationId).eq("type", "user_message"),
      )
      .order("desc")
      .first();
    const deviceId = typeof event?.deviceId === "string" ? event.deviceId.trim() : "";
    return deviceId || null;
  },
});

export const saveAssistantMessage = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    text: v.string(),
    userMessageId: v.optional(v.id("events")),
    usage: v.optional(usageSummaryValidator),
  },
  returns: v.id("events"),
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    const eventId = await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp,
      type: "assistant_message",
      payload: {
        text: args.text,
        ...(args.userMessageId && { userMessageId: args.userMessageId }),
        ...(args.usage && { usage: args.usage }),
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
    toolArgs: jsonValueValidator,
    sourceDeviceId: v.optional(v.string()),
    userMessageId: v.optional(v.id("events")),
    agentType: v.optional(v.string()),
  },
  returns: v.union(eventValidator, v.null()),
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    const payload = sanitizeEventPayloadForStorage("tool_request", {
      toolName: args.toolName,
      args: args.toolArgs ?? {},
      targetDeviceId: args.targetDeviceId,
      sourceDeviceId: args.sourceDeviceId,
      userMessageId: args.userMessageId,
      agentType: args.agentType,
    });
    const eventId = await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp,
      type: "tool_request",
      requestId: args.requestId,
      targetDeviceId: args.targetDeviceId,
      deviceId: args.sourceDeviceId,
      payload,
    });
    await ctx.db.patch(args.conversationId, { updatedAt: timestamp });
    return await ctx.db.get(eventId);
  },
});

export const getToolResultByRequestId = internalQuery({
  args: {
    requestId: v.string(),
    deviceId: v.optional(v.string()),
  },
  returns: v.union(eventValidator, v.null()),
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("events")
      .withIndex("by_request", (q) => q.eq("requestId", args.requestId))
      .order("desc")
      .take(20);
    const match =
      results.find((event) => {
        if (event.type !== "tool_result") {
          return false;
        }
        if (args.deviceId && event.deviceId !== args.deviceId) {
          return false;
        }
        return true;
      }) ?? null;
    return sanitizeEventForRead(match);
  },
});

export const getToolResult = query({
  args: {
    requestId: v.string(),
    deviceId: v.optional(v.string()),
  },
  returns: v.union(eventValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const results = await ctx.db
      .query("events")
      .withIndex("by_request", (q) => q.eq("requestId", args.requestId))
      .order("desc")
      .take(20);
    const match =
      results.find((event) => {
        if (event.type !== "tool_result") {
          return false;
        }
        if (args.deviceId && event.deviceId !== args.deviceId) {
          return false;
        }
        return true;
      }) ?? null;

    if (!match) {
      return null;
    }

    const conversation = await ctx.db.get(match.conversationId);
    if (!conversation || conversation.ownerId !== ownerId) {
      return null;
    }

    return sanitizeEventForRead(match);
  },
});

const deviceRequiredTypes = new Set([
  "user_message",
  "tool_result",
  "screen_event",
]);

type AppendEventArgs = {
  conversationId: Id<"conversations">;
  type: string;
  timestamp?: number;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload: unknown;
};

const resolveAppendEventPayload = (args: AppendEventArgs) => {
  if (deviceRequiredTypes.has(args.type) && !args.deviceId) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `deviceId required for ${args.type}`,
    });
  }

  if (args.type === "tool_result" && !args.requestId) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "tool_result requires requestId",
    });
  }

  const sanitizedPayload = sanitizeEventPayloadForStorage(args.type, args.payload ?? {});
  const payloadTargetDeviceId =
    sanitizedPayload && typeof sanitizedPayload === "object"
      ? (sanitizedPayload as { targetDeviceId?: string }).targetDeviceId
      : undefined;
  const resolvedTargetDeviceId = args.targetDeviceId ?? payloadTargetDeviceId;

  if (args.type === "tool_request" && !resolvedTargetDeviceId) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "tool_request requires targetDeviceId",
    });
  }

  return {
    sanitizedPayload,
    resolvedTargetDeviceId,
    timestamp: args.timestamp ?? Date.now(),
  };
};

const appendEventCore = async (ctx: MutationCtx, args: AppendEventArgs) => {
  const { sanitizedPayload, resolvedTargetDeviceId, timestamp } = resolveAppendEventPayload(args);
  const eventId = await ctx.db.insert("events", {
    conversationId: args.conversationId,
    timestamp,
    type: args.type,
    deviceId: args.deviceId,
    requestId: args.requestId,
    targetDeviceId: resolvedTargetDeviceId,
    payload: sanitizedPayload,
  });

  await ctx.db.patch(args.conversationId, { updatedAt: timestamp });
  return sanitizeEventForRead(await ctx.db.get(eventId));
};

export const appendEvent = mutation({
  args: {
    conversationId: v.id("conversations"),
    type: v.string(),
    timestamp: v.optional(v.number()),
    deviceId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    payload: jsonValueValidator,
  },
  returns: v.union(eventValidator, v.null()),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    return await appendEventCore(ctx, args);
  },
});

export const appendInternalEvent = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    type: v.string(),
    timestamp: v.optional(v.number()),
    deviceId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    payload: jsonValueValidator,
  },
  returns: v.union(eventValidator, v.null()),
  handler: async (ctx, args) => {
    return await appendEventCore(ctx, args);
  },
});

export const listEvents = query({
  args: {
    conversationId: v.id("conversations"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(eventValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())),
  }),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    const page = await ctx.db
      .query("events")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: page.page.map((event) => sanitizeEventForRead(event)),
    };
  },
});

export const listEventsSince = query({
  args: {
    conversationId: v.id("conversations"),
    afterTimestamp: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.array(eventValidator),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    const afterTimestamp = args.afterTimestamp ?? 0;
    const requestedLimit = args.limit ?? 400;
    const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), 1000);

    const events = await ctx.db
      .query("events")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId).gt("timestamp", afterTimestamp),
      )
      .order("asc")
      .take(limit);

    return events.map((event) => sanitizeEventForRead(event));
  },
});

export const getConversationEventHead = query({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.object({
    latestTimestamp: v.number(),
    latestEventId: v.union(v.id("events"), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    const latest = await ctx.db
      .query("events")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();

    return {
      latestTimestamp: latest?.timestamp ?? 0,
      latestEventId: latest?._id ?? null,
    };
  },
});

export const listToolRequestsForDevice = query({
  args: {
    deviceId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    paginationOpts: paginationOptsValidator,
    // Only return requests created after this timestamp (for fresh subscriptions)
    since: v.optional(v.number()),
  },
  returns: v.object({
    page: v.array(eventValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const page = await ctx.db
      .query("events")
      .withIndex("by_target_device", (q) => q.eq("targetDeviceId", args.deviceId))
      .order("desc")
      .paginate(args.paginationOpts);

    const filtered: typeof page.page = [];
    for (const event of page.page) {
      if (event.type !== "tool_request") {
        continue;
      }
      // Skip events older than 'since' timestamp (ignore historical requests)
      if (args.since !== undefined && event.timestamp < args.since) {
        continue;
      }
      if (args.conversationId && event.conversationId !== args.conversationId) {
        continue;
      }
      const conversation = await ctx.db.get(event.conversationId);
      if (!conversation || conversation.ownerId !== ownerId) {
        continue;
      }
      filtered.push(event);
    }

    return {
      ...page,
      page: filtered,
    };
  },
});
