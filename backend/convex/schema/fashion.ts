import { defineTable } from "convex/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Validators (also exported so data/fashion.ts can reuse them)
// ---------------------------------------------------------------------------

/**
 * Optional free-form sizes object. Most fashion flows only need the local body
 * photo; when sizes are provided, the agent receives them verbatim.
 */
export const fashion_sizes_validator = v.record(v.string(), v.string());

/**
 * One garment slotted into an outfit. Slot lets the agent express what role
 * the item plays in the look (top, bottom, shoe, outerwear, accessory, etc.)
 * so the renderer can lay them around the try-on image consistently.
 */
export const fashion_outfit_product_validator = v.object({
  slot: v.string(),
  productId: v.string(),
  variantId: v.string(),
  title: v.string(),
  price: v.optional(v.number()),
  currency: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  productUrl: v.optional(v.string()),
  merchantOrigin: v.string(),
  checkoutUrl: v.optional(v.string()),
  vendor: v.optional(v.string()),
});

const fashionProfileFields = {
  ownerId: v.string(),
  displayName: v.optional(v.string()),
  sizes: v.optional(fashion_sizes_validator),
  stylePreferences: v.optional(v.string()),
  hasBodyPhoto: v.boolean(),
  bodyPhotoMimeType: v.optional(v.string()),
  bodyPhotoUpdatedAt: v.optional(v.number()),
  updatedAt: v.number(),
};

const fashionOutfitFields = {
  ownerId: v.string(),
  batchId: v.string(),
  ordinal: v.number(),
  status: v.union(
    v.literal("generating"),
    v.literal("ready"),
    v.literal("failed"),
  ),
  stylePrompt: v.optional(v.string()),
  themeLabel: v.string(),
  themeDescription: v.optional(v.string()),
  products: v.array(fashion_outfit_product_validator),
  tryOnImagePath: v.optional(v.string()),
  tryOnImageUrl: v.optional(v.string()),
  tryOnPrompt: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  createdAt: v.number(),
  readyAt: v.optional(v.number()),
};

const fashionLikeFields = {
  ownerId: v.string(),
  variantId: v.string(),
  productId: v.string(),
  title: v.string(),
  imageUrl: v.optional(v.string()),
  productUrl: v.optional(v.string()),
  merchantOrigin: v.string(),
  priceCents: v.optional(v.number()),
  currency: v.optional(v.string()),
  vendor: v.optional(v.string()),
  likedAt: v.number(),
};

const fashionCartItemFields = {
  ownerId: v.string(),
  variantId: v.string(),
  productId: v.string(),
  title: v.string(),
  imageUrl: v.optional(v.string()),
  productUrl: v.optional(v.string()),
  merchantOrigin: v.string(),
  checkoutUrl: v.optional(v.string()),
  priceCents: v.optional(v.number()),
  currency: v.optional(v.string()),
  vendor: v.optional(v.string()),
  quantity: v.number(),
  addedAt: v.number(),
  checkoutSessionId: v.optional(v.id("fashion_checkout_sessions")),
};

const fashionCheckoutSessionFields = {
  ownerId: v.string(),
  merchantOrigin: v.string(),
  mcpEndpoint: v.optional(v.string()),
  checkoutId: v.string(),
  status: v.string(),
  continueUrl: v.optional(v.string()),
  rawResponse: v.optional(v.string()),
  createdAt: v.number(),
  expiresAt: v.optional(v.number()),
  updatedAt: v.number(),
};

// ---------------------------------------------------------------------------
// Row validators (handy for return types in queries/actions)
// ---------------------------------------------------------------------------

export const fashion_profile_validator = v.object({
  _id: v.id("fashion_profiles"),
  _creationTime: v.number(),
  ...fashionProfileFields,
});

export const fashion_outfit_validator = v.object({
  _id: v.id("fashion_outfits"),
  _creationTime: v.number(),
  ...fashionOutfitFields,
});

export const fashion_like_validator = v.object({
  _id: v.id("fashion_likes"),
  _creationTime: v.number(),
  ...fashionLikeFields,
});

export const fashion_cart_item_validator = v.object({
  _id: v.id("fashion_cart_items"),
  _creationTime: v.number(),
  ...fashionCartItemFields,
});

export const fashion_checkout_session_validator = v.object({
  _id: v.id("fashion_checkout_sessions"),
  _creationTime: v.number(),
  ...fashionCheckoutSessionFields,
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const fashionSchema = {
  fashion_profiles: defineTable(fashionProfileFields).index(
    "by_ownerId",
    ["ownerId"],
  ),

  fashion_outfits: defineTable(fashionOutfitFields)
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_ownerId_and_batchId", ["ownerId", "batchId"]),

  fashion_likes: defineTable(fashionLikeFields)
    .index("by_ownerId_and_likedAt", ["ownerId", "likedAt"])
    .index("by_ownerId_and_variantId", ["ownerId", "variantId"]),

  fashion_cart_items: defineTable(fashionCartItemFields)
    .index("by_ownerId_and_addedAt", ["ownerId", "addedAt"])
    .index("by_ownerId_and_variantId", ["ownerId", "variantId"]),

  fashion_checkout_sessions: defineTable(fashionCheckoutSessionFields)
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_ownerId_and_merchantOrigin", ["ownerId", "merchantOrigin"]),
};
