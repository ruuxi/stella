import { defineTable } from "convex/server";
import { v } from "convex/values";

export const emoji_pack_visibility_validator = v.union(
  v.literal("public"),
  v.literal("unlisted"),
  v.literal("private"),
);

const emojiPackFields = {
  ownerId: v.string(),
  packId: v.string(),
  displayName: v.string(),
  description: v.optional(v.string()),
  prompt: v.optional(v.string()),
  coverEmoji: v.string(),
  sheet1Url: v.string(),
  sheet2Url: v.string(),
  visibility: emoji_pack_visibility_validator,
  searchText: v.string(),
  authorDisplayName: v.optional(v.string()),
  authorHandle: v.optional(v.string()),
  installCount: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const emoji_pack_validator = v.object({
  _id: v.id("emoji_packs"),
  _creationTime: v.number(),
  ...emojiPackFields,
});

export const emojiPacksSchema = {
  emoji_packs: defineTable(emojiPackFields)
    .index("by_packId", ["packId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_packId", ["ownerId", "packId"])
    .index("by_visibility_and_updatedAt", ["visibility", "updatedAt"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["visibility"],
    }),
};
