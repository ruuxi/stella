import { defineTable } from "convex/server";
import { v } from "convex/values";
import { jsonValueValidator, optionalChannelEnvelopeValidator } from "../shared_validators";

/** All event `type` values written by the app (appendEvent + internal inserters). */
export const eventTypeValidator = v.union(
  v.literal("user_message"),
  v.literal("assistant_message"),
  v.literal("task_started"),
  v.literal("task_completed"),
  v.literal("task_failed"),
  v.literal("task_canceled"),
  v.literal("task_progress"),
  v.literal("tool_request"),
  v.literal("tool_result"),
  v.literal("microcompact_boundary"),
  v.literal("remote_turn_request"),
  v.literal("remote_turn_claimed"),
  v.literal("remote_turn_fulfilled"),
  v.literal("screen_event"),
);

export const threadStatusValidator = v.union(
  v.literal("active"),
  v.literal("idle"),
  v.literal("archived"),
);

export const conversationsSchema = {
  conversations: defineTable({
    ownerId: v.string(),
    title: v.optional(v.string()),
    isDefault: v.boolean(),
    activeThreadId: v.optional(v.id("threads")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_isDefault", ["ownerId", "isDefault"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  events: defineTable({
    conversationId: v.id("conversations"),
    timestamp: v.number(),
    type: eventTypeValidator,
    deviceId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    payload: jsonValueValidator,
    channelEnvelope: optionalChannelEnvelopeValidator,
  })
    .index("by_conversationId_and_timestamp", ["conversationId", "timestamp"])
    .index("by_conversationId_and_type_and_timestamp", ["conversationId", "type", "timestamp"])
    .index("by_targetDeviceId_and_timestamp", ["targetDeviceId", "timestamp"])
    .index("by_requestId", ["requestId"]),

  attachments: defineTable({
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    storageKey: v.id("_storage"),
    url: v.optional(v.string()),
    mimeType: v.string(),
    size: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversationId", ["conversationId"])
    .index("by_deviceId", ["deviceId"]),

  threads: defineTable({
    conversationId: v.id("conversations"),
    name: v.string(),
    status: threadStatusValidator,
    summary: v.optional(v.string()),
    messageCount: v.number(),
    totalTokenEstimate: v.number(),
    createdAt: v.number(),
    lastUsedAt: v.number(),
    resurfacedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_conversationId_and_status_and_lastUsedAt", ["conversationId", "status", "lastUsedAt"])
    .index("by_conversationId_and_name", ["conversationId", "name"])
    .index("by_conversationId_and_lastUsedAt", ["conversationId", "lastUsedAt"])
    .index("by_status_and_lastUsedAt", ["status", "lastUsedAt"]),

  thread_messages: defineTable({
    threadId: v.id("threads"),
    ordinal: v.number(),
    role: v.string(),
    content: v.string(),
    toolCallId: v.optional(v.string()),
    tokenEstimate: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_threadId_and_ordinal", ["threadId", "ordinal"]),
};
