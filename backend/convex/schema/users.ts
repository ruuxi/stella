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

  linq_chats: defineTable({
    phoneNumber: v.string(),
    linqChatId: v.string(),
    createdAt: v.number(),
  })
    .index("by_phoneNumber", ["phoneNumber"]),

  /**
   * Denormalized per-owner counters. Singleton row per `ownerId` updated by
   * mutations that change the underlying row counts. Lets quota checks (e.g.
   * `MAX_CONVERSATIONS_PER_USER`) run in O(1) instead of scanning the
   * conversations table on every create.
   */
  user_counters: defineTable({
    ownerId: v.string(),
    conversationCount: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  /**
   * Public creator profile. One row per ownerId. `publicHandle` is the
   * URL-stable slug used for `/c/:handle` and for `parent.authorHandle`
   * references on releases. `displayName` is the user-pickable label
   * shown on the creator page; defaults to the handle when empty.
   *
   * Uniqueness on `publicHandle` is enforced inside the `claimHandle`
   * mutation by querying the `by_publicHandle` index in the same
   * transaction (Convex indexes are not declarative unique constraints).
   */
  user_profiles: defineTable({
    ownerId: v.string(),
    publicHandle: v.string(),
    displayName: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_publicHandle", ["publicHandle"]),
};
