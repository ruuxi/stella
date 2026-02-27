import { defineTable } from "convex/server";
import { v } from "convex/values";

export const usersSchema = {
  user_preferences: defineTable({
    ownerId: v.string(),
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_key", ["ownerId", "key"])
    .index("by_key", ["key"]),

  canvas_states: defineTable({
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    name: v.string(),
    title: v.optional(v.string()),
    url: v.optional(v.string()),
    width: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_conversationId", ["ownerId", "conversationId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  self_mod_features: defineTable({
    featureId: v.string(),
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    name: v.string(),
    description: v.optional(v.string()),
    status: v.string(),
    batchCount: v.number(),
    files: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_conversationId_and_updatedAt", ["conversationId", "updatedAt"])
    .index("by_featureId", ["featureId"]),

  linq_chats: defineTable({
    phoneNumber: v.string(),
    linqChatId: v.string(),
    createdAt: v.number(),
  })
    .index("by_phoneNumber", ["phoneNumber"]),
};
