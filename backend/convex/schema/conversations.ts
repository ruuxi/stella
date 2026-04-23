import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  channelAttachmentValidator,
  jsonValueValidator,
  optionalChannelEnvelopeValidator,
} from "../shared_validators";

/** All event `type` values written by the app (appendEvent + internal inserters).
 *
 * Subagent lifecycle events use kebab-case to match the IPC wire format
 * (`AGENT_STREAM_EVENT_TYPES`). Other events keep snake_case for historical
 * consistency with the rest of the events table. */
export const eventTypeValidator = v.union(
  v.literal("user_message"),
  v.literal("assistant_message"),
  v.literal("agent-started"),
  v.literal("agent-completed"),
  v.literal("agent-failed"),
  v.literal("agent-canceled"),
  v.literal("agent-progress"),
  v.literal("tool_request"),
  v.literal("tool_result"),
  v.literal("microcompact_boundary"),
  v.literal("remote_turn_request"),
  v.literal("screen_event"),
);

/**
 * Lifecycle marker for `remote_turn_request` events. The previous design
 * inserted separate `remote_turn_claimed` / `remote_turn_fulfilled` event
 * rows under `requestId` prefixes (`claimed:...`, `fulfilled:...`) which
 * forced the device subscription query to do two extra index lookups per
 * candidate event. Now we patch this field on the original request row so
 * readers can decide everything from a single read.
 */
export const remoteTurnRequestStateValidator = v.union(
  v.literal("pending"),
  v.literal("claimed"),
  v.literal("fulfilled"),
);

export const threadStatusValidator = v.union(
  v.literal("active"),
  v.literal("idle"),
  v.literal("archived"),
);

export const pendingDeviceOptionValidator = v.object({
  deviceId: v.string(),
  deviceName: v.string(),
  platform: v.optional(v.string()),
});

export const pendingDeviceSelectionValidator = v.object({
  createdAt: v.number(),
  provider: v.string(),
  promptText: v.string(),
  attachments: v.optional(v.array(channelAttachmentValidator)),
  channelEnvelope: optionalChannelEnvelopeValidator,
  deliveryMeta: jsonValueValidator,
  deviceOptions: v.array(pendingDeviceOptionValidator),
});

export const conversationsSchema = {
  conversations: defineTable({
    ownerId: v.string(),
    title: v.optional(v.string()),
    isDefault: v.boolean(),
    activeThreadId: v.optional(v.id("threads")),
    activeTargetDeviceId: v.optional(v.string()),
    /**
     * Pointer to the conversation's pending device-selection prompt, if any.
     * The selection blob (which can carry sizable arrays of device options
     * and attachments) lives on the child `pending_device_selections` table
     * so writing/clearing the prompt doesn't rewrite — or contend with — the
     * conversation document.
     */
    pendingSelectionId: v.optional(v.id("pending_device_selections")),
    /**
     * Denormalized count of `events` rows for this conversation. Maintained by
     * `appendEventCore` so callers can read counts in O(1) without
     * paginating the events table.
     */
    eventCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_isDefault", ["ownerId", "isDefault"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  /**
   * Pending device-selection prompts split out from the `conversations`
   * document. One row per conversation that's currently waiting on a
   * device-selection reply; the row is inserted by
   * `setPendingDeviceSelection` and deleted by
   * `clearPendingDeviceSelection`. The conversation doc carries a
   * `pendingSelectionId` pointer for O(1) hydration.
   */
  pending_device_selections: defineTable({
    conversationId: v.id("conversations"),
    selection: pendingDeviceSelectionValidator,
    updatedAt: v.number(),
  }).index("by_conversationId", ["conversationId"]),

  events: defineTable({
    conversationId: v.id("conversations"),
    timestamp: v.number(),
    type: eventTypeValidator,
    deviceId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    /**
     * Set only on `remote_turn_request` events. Initialised to `"pending"`
     * at insert time, patched to `"claimed"` when a desktop device picks
     * the request up, and patched to `"fulfilled"` once delivery succeeds.
     */
    requestState: v.optional(remoteTurnRequestStateValidator),
    /** Set only on `remote_turn_request` events once a device claims them. */
    claimedByDeviceId: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    fulfilledAt: v.optional(v.number()),
    payload: jsonValueValidator,
    channelEnvelope: optionalChannelEnvelopeValidator,
  })
    .index("by_conversationId_and_timestamp", ["conversationId", "timestamp"])
    .index("by_conversationId_and_type_and_timestamp", ["conversationId", "type", "timestamp"])
    .index("by_targetDeviceId_and_timestamp", ["targetDeviceId", "timestamp"])
    // Type-scoped device subscription queries (`subscribeRemoteTurnRequestsForDevice`
    // and friends) read by `(targetDeviceId, type, timestamp)` so adding the
    // `type` column to the index lets them stream the exact rows they need
    // instead of over-fetching by 3x and JS-filtering.
    .index("by_targetDeviceId_and_type_and_timestamp", ["targetDeviceId", "type", "timestamp"])
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
