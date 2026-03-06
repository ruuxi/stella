import { paginationOptsValidator } from "convex/server";
import { mutation, query, internalQuery, internalMutation } from "./_generated/server";
import { v, ConvexError, Infer, type Value } from "convex/values";
import { internal, components } from "./_generated/api";
import { RateLimiter } from "@convex-dev/rate-limiter";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireConversationOwner, requireUserId } from "./auth";
import { jsonValueValidator, optionalChannelEnvelopeValidator } from "./shared_validators";
import { normalizeOptionalInt } from "./lib/number_utils";
import {
  estimateContextEventTokens,
  selectRecentByTokenBudget,
} from "./lib/context_window";

const rateLimiter = new RateLimiter(components.rateLimiter);

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
  channelEnvelope: optionalChannelEnvelopeValidator,
});

const usageSummaryValidator = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
});

const localSyncMessageValidator = v.object({
  localMessageId: v.string(),
  role: v.union(v.literal("user"), v.literal("assistant")),
  text: v.string(),
  timestamp: v.number(),
  deviceId: v.optional(v.string()),
});

const PAGINATION_PAGE_SIZE = 1000;
const MAX_EVENTS_QUERY_LIMIT = 2000;
const MAX_SYNC_EVENTS_QUERY_LIMIT = 1000;
const MAX_CONTEXT_TOKENS = 120_000;
const MIN_SCAN_LIMIT = 240;
const MAX_SCAN_LIMIT = 2400;
const APPEND_EVENT_RATE = { rate: 100, period: 10_000 } as const;
const IMPORT_CHUNK_RATE = { rate: 30, period: 10_000 } as const;

const sanitizeEventForRead = <T extends { type: string; payload: Value } | null>(
  event: T,
): T => {
  if (!event) {
    return event;
  }
  return {
    ...event,
    payload: event.payload ?? {},
  } as T;
};

export const countByConversation = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    let total = 0;
    let cursor: string | null = null;

    while (true) {
      const page = await ctx.db
        .query("events")
        .withIndex("by_conversationId_and_timestamp", (q) =>
          q.eq("conversationId", args.conversationId),
        )
        .paginate({ cursor, numItems: PAGINATION_PAGE_SIZE });
      total += page.page.length;
      if (page.isDone) {
        break;
      }
      cursor = page.continueCursor;
    }

    return total;
  },
});

export const listOlderMessages = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    beforeTimestamp: v.number(),
    afterTimestamp: v.optional(v.number()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const afterTs = args.afterTimestamp ?? 0;
    // Use by_conversation_type index for efficient type-scoped queries.
    const [userMessages, assistantMessages] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
          q
            .eq("conversationId", args.conversationId)
            .eq("type", "user_message")
            .gt("timestamp", afterTs)
            .lt("timestamp", args.beforeTimestamp),
        )
        .order("asc")
        .take(args.limit),
      ctx.db
        .query("events")
        .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
          q
            .eq("conversationId", args.conversationId)
            .eq("type", "assistant_message")
            .gt("timestamp", afterTs)
            .lt("timestamp", args.beforeTimestamp),
        )
        .order("asc")
        .take(args.limit),
    ]);

    return orderEventsChronologically([...userMessages, ...assistantMessages])
      .slice(0, args.limit);
  },
});

export const listMessagesInWindow = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    startTimestamp: v.number(),
    endTimestamp: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.endTimestamp <= args.startTimestamp) {
      return [];
    }

    const limit = normalizeOptionalInt({
      value: args.limit,
      defaultValue: 400,
      min: 1,
      max: MAX_EVENTS_QUERY_LIMIT,
    });

    const types = ["user_message", "assistant_message", "task_completed"] as const;
    const perType = await Promise.all(
      types.map((type) =>
        ctx.db
          .query("events")
          .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
            q
              .eq("conversationId", args.conversationId)
              .eq("type", type)
              .gt("timestamp", args.startTimestamp)
              .lte("timestamp", args.endTimestamp),
          )
          .order("asc")
          .take(limit),
      ),
    );

    return orderEventsChronologically(perType.flat())
      .slice(0, limit);
  },
});
export const getById = internalQuery({
  args: { id: v.id("events") },
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
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? 20;
    if (requestedLimit <= 0) {
      return [];
    }
    const limit = Math.min(Math.floor(requestedLimit), 100);
    // 3x overfetch: we query 2 type-specific indexes and merge, so ~1/2 of rows match per type
    const take = Math.min(Math.max(limit * 3, 50), 200);

    const [userEvents, assistantEvents] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
          q.eq("conversationId", args.conversationId).eq("type", "user_message"),
        )
        .order("desc")
        .take(take),
      ctx.db
        .query("events")
        .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
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

    combined = orderEventsChronologically(combined);

    if (combined.length > limit) {
      combined = combined.slice(-limit);
    }

    return combined;
  },
});

const MODEL_CONTEXT_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
  "microcompact_boundary",
  "task_started",
  "task_completed",
  "task_failed",
]);

const CHAT_CONTEXT_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
]);

type ContextEvent = Infer<typeof eventValidator>;
type RecentConversationEventsArgs = {
  conversationId: Id<"conversations">;
  beforeTimestamp?: number;
  excludeEventId?: Id<"events">;
  take: number;
};

type ContextEventFilterOptions = {
  includeOperationalEvents?: boolean;
  contextAgentType?: string;
};

const filterOrchestratorContextEvents = (
  eventsNewestFirst: ContextEvent[],
): ContextEvent[] => {
  return eventsNewestFirst.filter((event) => {
    if (event.type === "microcompact_boundary") {
      return true;
    }

    if (event.type === "user_message" || event.type === "assistant_message") {
      return true;
    }

    if (
      event.type === "task_started" ||
      event.type === "task_completed" ||
      event.type === "task_failed"
    ) {
      // Subagent task lifecycle should not pollute orchestrator context.
      return false;
    }

    return false;
  });
};

const fetchRecentConversationEvents = async (
  ctx: QueryCtx,
  args: RecentConversationEventsArgs,
): Promise<ContextEvent[]> => {
  const query = ctx.db.query("events").withIndex("by_conversationId_and_timestamp", (q) => {
    const base = q.eq("conversationId", args.conversationId);
    if (args.beforeTimestamp !== undefined) {
      return base.lte("timestamp", args.beforeTimestamp);
    }
    return base;
  });

  let events = await query.order("desc").take(args.take);
  if (args.excludeEventId) {
    events = events.filter((event) => event._id !== args.excludeEventId);
  }
  return events;
};

const filterContextEvents = (
  eventsNewestFirst: ContextEvent[],
  options?: ContextEventFilterOptions,
): ContextEvent[] => {
  const modelEvents = eventsNewestFirst.filter((event) => MODEL_CONTEXT_EVENT_TYPES.has(event.type));
  if (options?.includeOperationalEvents === false) {
    return modelEvents.filter((event) => CHAT_CONTEXT_EVENT_TYPES.has(event.type));
  }
  if (options?.contextAgentType === "orchestrator") {
    return filterOrchestratorContextEvents(modelEvents);
  }
  return modelEvents;
};

const orderEventsChronologically = <T extends { timestamp: number; _id: Id<"events"> }>(
  events: T[],
): T[] => {
  events.sort(
    (a, b) =>
      a.timestamp - b.timestamp || String(a._id).localeCompare(String(b._id)),
  );
  return events;
};

export const listRecentContextEvents = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    limit: v.optional(v.number()),
    beforeTimestamp: v.optional(v.number()),
    excludeEventId: v.optional(v.id("events")),
  },
  handler: async (ctx, args) => {
    const requestedLimit = args.limit ?? 20;
    if (requestedLimit <= 0) {
      return [];
    }
    const limit = Math.min(Math.floor(requestedLimit), 120);
    // 8x overfetch: context events include many non-message types (tool calls, task events, etc.) that get filtered
    const take = Math.min(Math.max(limit * 8, 80), 800);
    let events = await fetchRecentConversationEvents(ctx, {
      conversationId: args.conversationId,
      beforeTimestamp: args.beforeTimestamp,
      excludeEventId: args.excludeEventId,
      take,
    });
    events = orderEventsChronologically(filterContextEvents(events));

    if (events.length > limit) {
      events = events.slice(-limit);
    }

    return events.map((event) => sanitizeEventForRead(event));
  },
});

export const listSessionContextEvents = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    beforeTimestamp: v.optional(v.number()),
    excludeEventId: v.optional(v.id("events")),
    includeOperationalEvents: v.optional(v.boolean()),
    contextAgentType: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = normalizeOptionalInt({
      value: args.limit,
      defaultValue: 50_000,
      min: 1,
      max: 50_000,
    });
    let events = await fetchRecentConversationEvents(ctx, {
      conversationId: args.conversationId,
      beforeTimestamp: args.beforeTimestamp,
      excludeEventId: args.excludeEventId,
      take: limit,
    });
    events = orderEventsChronologically(filterContextEvents(events, {
      includeOperationalEvents: args.includeOperationalEvents,
      contextAgentType: args.contextAgentType,
    }));
    return events.map((event) => sanitizeEventForRead(event));
  },
});

export const listRecentContextEventsByTokens = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    maxTokens: v.optional(v.number()),
    beforeTimestamp: v.optional(v.number()),
    excludeEventId: v.optional(v.id("events")),
    includeOperationalEvents: v.optional(v.boolean()),
    contextAgentType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const maxTokens = Math.min(
      Math.max(Math.floor(args.maxTokens ?? 24_000), 1),
      MAX_CONTEXT_TOKENS,
    );
    // Approximate how many recent rows we may need to cover maxTokens.
    // Clamp for predictable query cost.
    const scanLimit = Math.min(
      Math.max(Math.ceil(maxTokens / 6), MIN_SCAN_LIMIT),
      MAX_SCAN_LIMIT,
    );
    const events = await fetchRecentConversationEvents(ctx, {
      conversationId: args.conversationId,
      beforeTimestamp: args.beforeTimestamp,
      excludeEventId: args.excludeEventId,
      take: scanLimit,
    });
    const contextEvents = filterContextEvents(events, {
      includeOperationalEvents: args.includeOperationalEvents,
      contextAgentType: args.contextAgentType,
    });

    const selectedNewestFirst = selectRecentByTokenBudget({
      itemsNewestFirst: contextEvents,
      maxTokens,
      estimateTokens: (event) =>
        estimateContextEventTokens({
          type: event.type,
          payload: event.payload,
          requestId: event.requestId,
        }),
    });

    const sorted = orderEventsChronologically(selectedNewestFirst);

    return sorted.map((event) => sanitizeEventForRead(event));
  },
});

export const getLatestDeviceIdForConversation = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
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
const deviceRequiredTypes = new Set([
  "user_message",
  "screen_event",
]);

type AppendEventArgs = {
  conversationId: Id<"conversations">;
  type: string;
  timestamp?: number;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload: Value;
  channelEnvelope?: Infer<typeof optionalChannelEnvelopeValidator>;
};

const resolveAppendEventPayload = (args: AppendEventArgs) => {
  if (deviceRequiredTypes.has(args.type) && !args.deviceId) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `deviceId required for ${args.type}`,
    });
  }

  if (args.type === "user_message") {
    const text = (args.payload as Record<string, unknown>)?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "user_message requires non-empty text",
      });
    }
    if (text.length > 100_000) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "user_message text exceeds maximum allowed length of 100,000 characters",
      });
    }
  }

  return {
    payload: args.payload ?? {},
    targetDeviceId: args.targetDeviceId,
    timestamp: args.timestamp ?? Date.now(),
  };
};

const appendEventCore = async (ctx: MutationCtx, args: AppendEventArgs) => {
  const { payload, targetDeviceId, timestamp } = resolveAppendEventPayload(args);
  const eventId = await ctx.db.insert("events", {
    conversationId: args.conversationId,
    timestamp,
    type: args.type,
    deviceId: args.deviceId,
    requestId: args.requestId,
    targetDeviceId,
    payload,
    channelEnvelope: args.channelEnvelope,
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
    channelEnvelope: optionalChannelEnvelopeValidator,
  },
  returns: v.union(v.null(), eventValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);

    const status = await rateLimiter.limit(ctx, "appendEvent", {
      key: ownerId,
      config: { kind: "fixed window", ...APPEND_EVENT_RATE },
    });
    if (!status.ok) {
      throw new ConvexError({
        code: "RATE_LIMITED",
        message: "Too many events. Please try again later.",
      });
    }

    await requireConversationOwner(ctx, args.conversationId);
    return await appendEventCore(ctx, args);
  },
});

export const importLocalMessagesChunk = mutation({
  args: {
    conversationId: v.id("conversations"),
    messages: v.array(localSyncMessageValidator),
  },
  returns: v.object({ imported: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);

    const status = await rateLimiter.limit(ctx, "importLocalMessagesChunk", {
      key: ownerId,
      config: { kind: "fixed window", ...IMPORT_CHUNK_RATE },
    });
    if (!status.ok) {
      throw new ConvexError({
        code: "RATE_LIMITED",
        message: "Too many import requests. Please try again later.",
      });
    }

    await requireConversationOwner(ctx, args.conversationId);

    let imported = 0;
    let skipped = 0;

    for (const message of args.messages) {
      let text = message.text.trim();
      if (!text) {
        skipped += 1;
        continue;
      }
      if (text.length > 100_000) {
        text = text.slice(0, 100_000);
      }

      const requestId = `local_sync:${args.conversationId}:${message.localMessageId}`;
      const existing = await ctx.db
        .query("events")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .first();
      if (existing && existing.conversationId === args.conversationId) {
        skipped += 1;
        continue;
      }

      let timestamp = Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
      if (timestamp > Date.now() + 60_000) {
        timestamp = Date.now();
      }
      const type = message.role === "assistant" ? "assistant_message" : "user_message";

      await appendEventCore(ctx, {
        conversationId: args.conversationId,
        type,
        timestamp,
        requestId,
        ...(type === "user_message"
          ? { deviceId: message.deviceId ?? "local-desktop" }
          : {}),
        payload: {
          text,
          source: "local_sync",
          localMessageId: message.localMessageId,
        },
      });
      imported += 1;
    }

    return {
      imported,
      skipped,
    };
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
    channelEnvelope: optionalChannelEnvelopeValidator,
  },
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
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null(),
      ),
    ),
  }),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    const page = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) =>
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

export const listEventsSince = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    afterTimestamp: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const afterTimestamp = args.afterTimestamp ?? 0;
    const limit = normalizeOptionalInt({
      value: args.limit,
      defaultValue: 400,
      min: 1,
      max: MAX_SYNC_EVENTS_QUERY_LIMIT,
    });

    const events = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) =>
        q.eq("conversationId", args.conversationId).gt("timestamp", afterTimestamp),
      )
      .order("asc")
      .take(limit);

    return events.map((event) => sanitizeEventForRead(event));
  },
});

export const getConversationEventHead = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();

    return {
      latestTimestamp: latest?.timestamp ?? 0,
      latestEventId: latest?._id ?? null,
    };
  },
});



/**
 * Factory for device-subscription query handlers.
 * All three subscribe-for-device queries share identical logic — they differ
 * only in the event-type filter string and the default/max limit values.
 */
function deviceSubscriptionHandler(opts: {
  eventType: string;
  defaultLimit: number;
  maxLimit: number;
}) {
  return async (
    ctx: QueryCtx,
    args: { deviceId: string; since: number; limit?: number },
  ) => {
    const ownerId = await requireUserId(ctx);
    const maxItems = normalizeOptionalInt({
      value: args.limit,
      defaultValue: opts.defaultLimit,
      min: 1,
      max: opts.maxLimit,
    });

    const events = await ctx.db
      .query("events")
      .withIndex("by_targetDeviceId_and_timestamp", (q) =>
        q.eq("targetDeviceId", args.deviceId).gte("timestamp", args.since),
      )
      .order("desc")
      .take(maxItems * 3); // Over-fetch to account for type/ownership filtering

    const ownershipCache = new Map<string, boolean>();
    const remoteTurnStatusCache = new Map<string, boolean>();
    const filtered: Infer<typeof eventValidator>[] = [];

    for (const event of events) {
      if (event.type !== opts.eventType) continue;

      if (opts.eventType === "remote_turn_request" && event.requestId) {
        let alreadyHandled = remoteTurnStatusCache.get(event.requestId);
        if (alreadyHandled === undefined) {
          const [claimed, fulfilled] = await Promise.all([
            ctx.db
              .query("events")
              .withIndex("by_requestId", (q) => q.eq("requestId", `claimed:${event.requestId}`))
              .first(),
            ctx.db
              .query("events")
              .withIndex("by_requestId", (q) => q.eq("requestId", `fulfilled:${event.requestId}`))
              .first(),
          ]);
          alreadyHandled = claimed !== null || fulfilled !== null;
          remoteTurnStatusCache.set(event.requestId, alreadyHandled);
        }
        if (alreadyHandled) continue;
      }

      const key = String(event.conversationId);
      let owned = ownershipCache.get(key);
      if (owned === undefined) {
        const conversation = await ctx.db.get(event.conversationId);
        owned = Boolean(conversation && conversation.ownerId === ownerId);
        ownershipCache.set(key, owned);
      }
      if (!owned) continue;

      filtered.push(event);
      if (filtered.length >= maxItems) break;
    }

    return filtered;
  };
}

const deviceSubscriptionArgs = {
  deviceId: v.string(),
  since: v.number(),
  limit: v.optional(v.number()),
};

export const subscribeRemoteTurnRequestsForDevice = query({
  args: deviceSubscriptionArgs,
  returns: v.array(eventValidator),
  handler: deviceSubscriptionHandler({
    eventType: "remote_turn_request",
    defaultLimit: 10,
    maxLimit: 50,
  }),
});

/** Public query — used by the local device runner for cross-restart dedup. */
export const isRemoteTurnClaimed = query({
  args: {
    requestId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await requireUserId(ctx);
    const event = await ctx.db
      .query("events")
      .withIndex("by_requestId", (q) => q.eq("requestId", `claimed:${args.requestId}`))
      .first();
    return event !== null;
  },
});

export const getRemoteTurnFulfilled = internalQuery({
  args: {
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("events")
      .withIndex("by_requestId", (q) => q.eq("requestId", `fulfilled:${args.requestId}`))
      .first();
    return event !== null;
  },
});

export const subscribeDashboardGenRequestsForDevice = query({
  args: deviceSubscriptionArgs,
  returns: v.array(eventValidator),
  handler: deviceSubscriptionHandler({
    eventType: "dashboard_generation_request",
    defaultLimit: 10,
    maxLimit: 50,
  }),
});
