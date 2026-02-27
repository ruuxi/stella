import { paginationOptsValidator } from "convex/server";
import { mutation, query, internalQuery, internalMutation } from "./_generated/server";
import { v, ConvexError, Infer, type Value } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireConversationOwner, requireUserId } from "./auth";
import { jsonValueValidator, optionalChannelEnvelopeValidator } from "./shared_validators";
import { normalizeOptionalInt } from "./lib/number_utils";
import { asPlainObjectRecord } from "./lib/object_utils";
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
  channelEnvelope: optionalChannelEnvelopeValidator,
  ephemeral: v.optional(v.boolean()),
  expiresAt: v.optional(v.number()),
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

const DEFAULT_EPHEMERAL_EVENT_TTL_MS = 30 * 60 * 1000;

const normalizeEphemeralEventTtlMs = (ttlMs?: number) => {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) {
    return DEFAULT_EPHEMERAL_EVENT_TTL_MS;
  }
  return Math.max(60_000, Math.floor(ttlMs));
};

const sanitizeEventPayloadForStorage = (type: string, payload: Value): Value => {
  if (type === "tool_result") {
    return sanitizeForToolResultPersistence(payload);
  }
  if (type === "tool_request") {
    return sanitizeForToolRequestPersistence(payload);
  }
  return payload;
};

const sanitizeEventPayloadForRead = (type: string, payload: Value): Value => {
  if (type === "tool_request" || type === "tool_result") {
    return sanitizeSensitiveData(payload, { redactFreeformStrings: true });
  }
  return payload;
};

const sanitizeEventForRead = <T extends { type: string; payload: Value } | null>(
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
  handler: async (ctx, args) => {
    let total = 0;
    let cursor: string | null = null;

    while (true) {
      const page = await ctx.db
        .query("events")
        .withIndex("by_conversationId_and_timestamp", (q) =>
          q.eq("conversationId", args.conversationId),
        )
        .paginate({ cursor, numItems: 1000 });
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

    return [...userMessages, ...assistantMessages]
      .sort(
        (a, b) =>
          a.timestamp - b.timestamp || String(a._id).localeCompare(String(b._id)),
      )
      .slice(0, args.limit);
  },
});

/**
 * Simple non-paginated query for HTTP polling (no multi-paginate issue).
 * Returns recent dashboard gen and tool request events for a device.
 */
export const listRecentDeviceEvents = query({
  args: {
    deviceId: v.string(),
    since: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const limit = args.limit ?? 20;

    const events = await ctx.db
      .query("events")
      .withIndex("by_targetDeviceId_and_timestamp", (q) =>
        q.eq("targetDeviceId", args.deviceId).gte("timestamp", args.since),
      )
      .order("desc")
      .take(limit * 3); // Over-fetch to account for filtering

    const result: Infer<typeof eventValidator>[] = [];
    const ownershipCache = new Map<string, boolean>();

    for (const event of events) {
      if (event.type !== "tool_request" && event.type !== "dashboard_generation_request") {
        continue;
      }
      const conversationKey = String(event.conversationId);
      let owned = ownershipCache.get(conversationKey);
      if (owned === undefined) {
        const conversation = await ctx.db.get(event.conversationId);
        owned = Boolean(conversation && conversation.ownerId === ownerId);
        ownershipCache.set(conversationKey, owned);
      }
      if (!owned) continue;

      result.push(event as Infer<typeof eventValidator>);
      if (result.length >= limit) break;
    }

    return result;
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
      max: 2000,
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

    return perType
      .flat()
      .sort(
        (a, b) =>
          a.timestamp - b.timestamp || String(a._id).localeCompare(String(b._id)),
      )
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

const asPayloadObject = (value: Value): Record<string, Value> =>
  asPlainObjectRecord<Value>(value);

const getEventPayloadAgentType = (event: ContextEvent): string | undefined => {
  const raw = asPayloadObject(event.payload).agentType;
  return typeof raw === "string" ? raw : undefined;
};

const filterOrchestratorContextEvents = (
  eventsNewestFirst: ContextEvent[],
): ContextEvent[] => {
  const orchestratorRequestIds = new Set<string>();
  for (const event of eventsNewestFirst) {
    if (event.type !== "tool_request" || !event.requestId) {
      continue;
    }
    if (getEventPayloadAgentType(event) === "orchestrator") {
      orchestratorRequestIds.add(event.requestId);
    }
  }

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

    if (event.type === "tool_request") {
      return getEventPayloadAgentType(event) === "orchestrator";
    }

    if (event.type === "tool_result") {
      const agentType = getEventPayloadAgentType(event);
      if (agentType === "orchestrator") {
        return true;
      }
      return !!(event.requestId && orchestratorRequestIds.has(event.requestId));
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
      120_000,
    );
    // Approximate how many recent rows we may need to cover maxTokens.
    // Clamp for predictable query cost.
    const scanLimit = Math.min(
      Math.max(Math.ceil(maxTokens / 6), 240),
      2400,
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

    orderEventsChronologically(selectedNewestFirst);

    return selectedNewestFirst.map((event) => sanitizeEventForRead(event));
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
    await ctx.scheduler.runAfter(0, internal.data.event_embeddings.indexEventForSemanticSearch, {
      eventId,
    });
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
    ephemeral: v.optional(v.boolean()),
    ttlMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const timestamp = Date.now();
    const isEphemeral = args.ephemeral === true;
    const expiresAt = isEphemeral
      ? timestamp + normalizeEphemeralEventTtlMs(args.ttlMs)
      : undefined;
    const payload = sanitizeEventPayloadForStorage("tool_request", {
      toolName: args.toolName,
      args: args.toolArgs ?? {},
      targetDeviceId: args.targetDeviceId,
      sourceDeviceId: args.sourceDeviceId,
      userMessageId: args.userMessageId,
      agentType: args.agentType,
      ephemeral: isEphemeral ? true : undefined,
    });
    const eventId = await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp,
      type: "tool_request",
      requestId: args.requestId,
      targetDeviceId: args.targetDeviceId,
      deviceId: args.sourceDeviceId,
      payload,
      ephemeral: isEphemeral ? true : undefined,
      expiresAt,
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
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("events")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
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
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const results = await ctx.db
      .query("events")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
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

export const deleteEventsByRequestId = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    let deleted = 0;
    while (true) {
      const rows = await ctx.db
        .query("events")
        .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
        .take(100);
      if (rows.length === 0) {
        break;
      }

      let deletedThisBatch = 0;
      for (const row of rows) {
        if (row.conversationId !== args.conversationId) {
          continue;
        }
        await ctx.db.delete(row._id);
        deleted += 1;
        deletedThisBatch += 1;
      }

      if (rows.length < 100 || deletedThisBatch === 0) {
        break;
      }
    }

    return deleted;
  },
});

export const purgeExpiredEphemeralToolEvents = internalMutation({
  args: {
    nowMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const nowMs = typeof args.nowMs === "number" ? args.nowMs : Date.now();
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(5_000, Math.floor(args.limit)))
        : 500;
    const maxBatches =
      typeof args.maxBatches === "number" && Number.isFinite(args.maxBatches)
        ? Math.max(1, Math.min(50, Math.floor(args.maxBatches)))
        : 10;

    let deleted = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      const expired = await ctx.db
        .query("events")
        .withIndex("by_ephemeral_and_expiresAt", (q) =>
          q.eq("ephemeral", true).lte("expiresAt", nowMs),
        )
        .take(limit);

      if (expired.length === 0) {
        break;
      }

      for (const row of expired) {
        if (row.type !== "tool_request" && row.type !== "tool_result") {
          continue;
        }
        await ctx.db.delete(row._id);
        deleted += 1;
      }

      if (expired.length < limit) {
        break;
      }
    }

    return deleted;
  },
});

const deviceRequiredTypes = new Set([
  "user_message",
  "tool_result",
  "screen_event",
]);
const SEMANTIC_INDEXED_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
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
  ephemeral?: boolean;
  expiresAt?: number;
};

const resolveAppendEventPayload = (args: AppendEventArgs) => {
  if (
    args.ephemeral === true &&
    args.type !== "tool_request" &&
    args.type !== "tool_result"
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "ephemeral is only supported for tool_request/tool_result",
    });
  }
  if (args.expiresAt !== undefined && args.ephemeral !== true) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "expiresAt requires ephemeral=true",
    });
  }

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
    sanitizedPayload &&
      typeof sanitizedPayload === "object" &&
      !Array.isArray(sanitizedPayload)
      ? (sanitizedPayload as { targetDeviceId?: Value }).targetDeviceId
      : undefined;
  const payloadTargetDeviceIdString =
    typeof payloadTargetDeviceId === "string" ? payloadTargetDeviceId : undefined;
  const resolvedTargetDeviceId = args.targetDeviceId ?? payloadTargetDeviceIdString;

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

const resolveEphemeralPersistence = async (
  ctx: MutationCtx,
  args: AppendEventArgs,
  timestamp: number,
): Promise<{ ephemeral?: boolean; expiresAt?: number }> => {
  if (args.ephemeral === true) {
    const expiresAt =
      typeof args.expiresAt === "number"
        ? args.expiresAt
        : timestamp + normalizeEphemeralEventTtlMs();
    return { ephemeral: true, expiresAt };
  }

  if (args.type !== "tool_result" || !args.requestId) {
    return {};
  }

  const relatedEvents = await ctx.db
    .query("events")
    .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId as string))
    .order("desc")
    .take(20);
  const toolRequest = relatedEvents.find(
    (event) =>
      event.type === "tool_request" &&
      event.requestId === args.requestId &&
      event.conversationId === args.conversationId,
  );
  if (!toolRequest || toolRequest.ephemeral !== true) {
    return {};
  }
  const expiresAt =
    typeof toolRequest.expiresAt === "number"
      ? toolRequest.expiresAt
      : timestamp + normalizeEphemeralEventTtlMs();
  return { ephemeral: true, expiresAt };
};

const appendEventCore = async (ctx: MutationCtx, args: AppendEventArgs) => {
  const { sanitizedPayload, resolvedTargetDeviceId, timestamp } = resolveAppendEventPayload(args);
  const { ephemeral, expiresAt } = await resolveEphemeralPersistence(ctx, args, timestamp);
  const eventId = await ctx.db.insert("events", {
    conversationId: args.conversationId,
    timestamp,
    type: args.type,
    deviceId: args.deviceId,
    requestId: args.requestId,
    targetDeviceId: resolvedTargetDeviceId,
    payload: sanitizedPayload,
    channelEnvelope: args.channelEnvelope,
    ephemeral,
    expiresAt,
  });

  await ctx.db.patch(args.conversationId, { updatedAt: timestamp });
  if (SEMANTIC_INDEXED_EVENT_TYPES.has(args.type)) {
    await ctx.scheduler.runAfter(0, internal.data.event_embeddings.indexEventForSemanticSearch, {
      eventId,
    });
  }
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
    ephemeral: v.optional(v.boolean()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    return await appendEventCore(ctx, args);
  },
});

export const importLocalMessagesChunk = mutation({
  args: {
    conversationId: v.id("conversations"),
    messages: v.array(localSyncMessageValidator),
  },
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);

    let imported = 0;
    let skipped = 0;

    for (const message of args.messages) {
      const text = message.text.trim();
      if (!text) {
        skipped += 1;
        continue;
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

      const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
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
    ephemeral: v.optional(v.boolean()),
    expiresAt: v.optional(v.number()),
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
      max: 1000,
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

// listEventsForSession removed

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

export const listToolRequestsForDevice = query({
  args: {
    deviceId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    paginationOpts: paginationOptsValidator,
    // Only return requests created after this timestamp (for fresh subscriptions)
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const filtered: Infer<typeof eventValidator>[] = [];
    const ownershipCache = new Map<string, boolean>();
    const requestedItems = normalizeOptionalInt({
      value: args.paginationOpts.numItems,
      defaultValue: 20,
      min: 1,
      max: 200,
    });
    let cursor: string | null = args.paginationOpts.cursor;
    let isDone = false;
    let splitCursor: string | null | undefined = undefined;
    let pageStatus: "SplitRecommended" | "SplitRequired" | null | undefined = undefined;

    while (filtered.length < requestedItems && !isDone) {
      const page = await ctx.db
        .query("events")
        .withIndex("by_targetDeviceId_and_timestamp", (q) => q.eq("targetDeviceId", args.deviceId))
        .order("desc")
        .paginate({
          cursor,
          numItems: requestedItems,
        });
      cursor = page.continueCursor;
      isDone = page.isDone;
      splitCursor = page.splitCursor;
      pageStatus = page.pageStatus;

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
        const conversationKey = String(event.conversationId);
        let owned = ownershipCache.get(conversationKey);
        if (owned === undefined) {
          const conversation = await ctx.db.get(event.conversationId);
          owned = Boolean(conversation && conversation.ownerId === ownerId);
          ownershipCache.set(conversationKey, owned);
        }
        if (!owned) {
          continue;
        }
        filtered.push(event);
        if (filtered.length >= requestedItems) {
          break;
        }
      }
    }

    return {
      page: filtered,
      isDone,
      continueCursor: cursor ?? args.paginationOpts.cursor ?? "",
      ...(splitCursor !== undefined ? { splitCursor } : {}),
      ...(pageStatus !== undefined ? { pageStatus } : {}),
    };
  },
});

export const listDashboardGenRequestsForDevice = query({
  args: {
    deviceId: v.string(),
    paginationOpts: paginationOptsValidator,
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const filtered: Infer<typeof eventValidator>[] = [];
    const ownershipCache = new Map<string, boolean>();
    const requestedItems = normalizeOptionalInt({
      value: args.paginationOpts.numItems,
      defaultValue: 20,
      min: 1,
      max: 200,
    });
    let cursor: string | null = args.paginationOpts.cursor;
    let isDone = false;
    let splitCursor: string | null | undefined = undefined;
    let pageStatus: "SplitRecommended" | "SplitRequired" | null | undefined = undefined;

    while (filtered.length < requestedItems && !isDone) {
      const page = await ctx.db
        .query("events")
        .withIndex("by_targetDeviceId_and_timestamp", (q) => q.eq("targetDeviceId", args.deviceId))
        .order("desc")
        .paginate({
          cursor,
          numItems: requestedItems,
        });
      cursor = page.continueCursor;
      isDone = page.isDone;
      splitCursor = page.splitCursor;
      pageStatus = page.pageStatus;

      for (const event of page.page) {
        if (event.type !== "dashboard_generation_request") {
          continue;
        }
        if (args.since !== undefined && event.timestamp < args.since) {
          continue;
        }
        const conversationKey = String(event.conversationId);
        let owned = ownershipCache.get(conversationKey);
        if (owned === undefined) {
          const conversation = await ctx.db.get(event.conversationId);
          owned = Boolean(conversation && conversation.ownerId === ownerId);
          ownershipCache.set(conversationKey, owned);
        }
        if (!owned) {
          continue;
        }
        filtered.push(event);
        if (filtered.length >= requestedItems) {
          break;
        }
      }
    }

    return {
      page: filtered,
      isDone,
      continueCursor: cursor ?? args.paginationOpts.cursor ?? "",
      ...(splitCursor !== undefined ? { splitCursor } : {}),
      ...(pageStatus !== undefined ? { pageStatus } : {}),
    };
  },
});

