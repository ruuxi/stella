import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  conversations: defineTable({
    ownerId: v.string(),
    title: v.optional(v.string()),
    isDefault: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_default", ["ownerId", "isDefault"])
    .index("by_owner_updated", ["ownerId", "updatedAt"]),
  events: defineTable({
    conversationId: v.id("conversations"),
    timestamp: v.number(),
    type: v.string(),
    deviceId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    payload: v.any(),
  })
    .index("by_conversation", ["conversationId", "timestamp"])
    .index("by_request", ["requestId"]),
  attachments: defineTable({
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    storageKey: v.string(),
    url: v.optional(v.string()),
    mimeType: v.string(),
    size: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_device", ["deviceId"]),
});
