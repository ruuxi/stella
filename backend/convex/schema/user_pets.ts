import { defineTable } from "convex/server";
import { v } from "convex/values";

export const user_pet_visibility_validator = v.union(
  v.literal("public"),
  v.literal("unlisted"),
  v.literal("private"),
);

const userPetFields = {
  ownerId: v.string(),
  petId: v.string(),
  displayName: v.string(),
  description: v.string(),
  prompt: v.optional(v.string()),
  spritesheetUrl: v.string(),
  /** Tiny 8-frame idle strip used by the Pets store grid so we don't
   *  need to fetch the full atlas just to render a card. */
  previewUrl: v.optional(v.string()),
  visibility: user_pet_visibility_validator,
  searchText: v.string(),
  authorDisplayName: v.optional(v.string()),
  authorHandle: v.optional(v.string()),
  installCount: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const user_pet_validator = v.object({
  _id: v.id("user_pets"),
  _creationTime: v.number(),
  ...userPetFields,
});

export const userPetsSchema = {
  user_pets: defineTable(userPetFields)
    .index("by_petId", ["petId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_petId", ["ownerId", "petId"])
    .index("by_visibility_and_updatedAt", ["visibility", "updatedAt"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["visibility"],
    }),
};
