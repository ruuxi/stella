/**
 * Fashion-tab CRUD: profiles, generated outfits, likes, cart, checkout sessions.
 *
 * The body photo itself is *not* stored on the backend — it lives only in
 * `state/fashion/body.{ext}` on the user's machine. We persist a `hasBodyPhoto`
 * flag plus mime-type/timestamp so the UI knows what shape the on-disk asset
 * should be without ever round-tripping bytes through Convex storage.
 */

import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { ConvexError, v } from "convex/values";
import { requireUserId } from "../auth";
import {
  enforceMutationRateLimit,
  RATE_HOT_PATH,
  RATE_SETTINGS,
  RATE_STANDARD,
} from "../lib/rate_limits";
import { requireBoundedString } from "../shared_validators";
import {
  fashion_cart_item_validator,
  fashion_like_validator,
  fashion_outfit_product_validator,
  fashion_outfit_validator,
  fashion_profile_validator,
  fashion_sizes_validator,
} from "../schema/fashion";
import { isShopifyUcpConfigured } from "../lib/shopify_ucp";

const MAX_DISPLAY_NAME = 80;
const MAX_GENDER = 80;
const MAX_PREFERENCES = 4000;
const MAX_PROMPT = 2000;
const MAX_THEME_LABEL = 120;
const MAX_THEME_DESCRIPTION = 600;
const MAX_TITLE = 240;
const MAX_URL = 2048;
const MAX_VENDOR = 160;
const MAX_MERCHANT = 160;
const MAX_ID = 256;
const MAX_BATCH_ID = 64;
const MAX_OUTFITS_PER_BATCH = 12;
const MAX_PRODUCTS_PER_OUTFIT = 12;
const MAX_FREEFORM_SIZE_KEYS = 24;
const MAX_FREEFORM_SIZE_VALUE = 64;

const trim = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const optionalText = (
  value: string | undefined,
  field: string,
  max: number,
): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  requireBoundedString(trimmed, field, max);
  return trimmed;
};

const requiredText = (
  value: string,
  field: string,
  max: number,
): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `${field} is required`,
    });
  }
  requireBoundedString(trimmed, field, max);
  return trimmed;
};

const normalizeSizes = (
  sizes: Record<string, string> | undefined,
): Record<string, string> => {
  if (!sizes) return {};
  const entries = Object.entries(sizes);
  if (entries.length > MAX_FREEFORM_SIZE_KEYS) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `Too many size entries (max ${MAX_FREEFORM_SIZE_KEYS})`,
    });
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of entries) {
    const k = trim(key).toLowerCase();
    const value = trim(raw);
    if (!k || !value) continue;
    requireBoundedString(k, `sizes.${key}`, 32);
    requireBoundedString(value, `sizes.${key}`, MAX_FREEFORM_SIZE_VALUE);
    out[k] = value;
  }
  return out;
};

const getProfileForOwner = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
) =>
  await ctx.db
    .query("fashion_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

// ---------------------------------------------------------------------------
// Feature flag — true when SHOPIFY_UCP_CLIENT_ID + SHOPIFY_UCP_CLIENT_SECRET
// are set on the backend deployment. The Fashion tab uses this to render a
// graceful "not configured" state instead of failing inside Shopify actions.
// ---------------------------------------------------------------------------

export const getFashionFeatureStatus = query({
  args: {},
  returns: v.object({
    shopifyConfigured: v.boolean(),
  }),
  handler: async () => ({
    shopifyConfigured: isShopifyUcpConfigured(),
  }),
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const getProfile = query({
  args: {},
  returns: v.union(v.null(), fashion_profile_validator),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await getProfileForOwner(ctx, ownerId);
  },
});

export const setProfile = mutation({
  args: {
    displayName: v.optional(v.string()),
    gender: v.optional(v.string()),
    sizes: v.optional(fashion_sizes_validator),
    stylePreferences: v.optional(v.string()),
  },
  returns: fashion_profile_validator,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "fashion_set_profile",
      ownerId,
      RATE_SETTINGS,
      "Too many fashion profile updates. Wait a moment and try again.",
    );

    const displayName = optionalText(args.displayName, "displayName", MAX_DISPLAY_NAME);
    const gender = optionalText(args.gender, "gender", MAX_GENDER);
    const stylePreferences = optionalText(
      args.stylePreferences,
      "stylePreferences",
      MAX_PREFERENCES,
    );
    const sizes = normalizeSizes(args.sizes);
    const hasSizes = Object.keys(sizes).length > 0;
    const now = Date.now();

    const existing = await getProfileForOwner(ctx, ownerId);
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...(displayName !== undefined ? { displayName } : { displayName: undefined }),
        ...(gender !== undefined ? { gender } : { gender: undefined }),
        ...(hasSizes ? { sizes } : { sizes: undefined }),
        ...(stylePreferences !== undefined
          ? { stylePreferences }
          : { stylePreferences: undefined }),
        updatedAt: now,
      });
      const updated = await ctx.db.get(existing._id);
      if (!updated) throw new ConvexError({ code: "INTERNAL_ERROR", message: "Profile vanished" });
      return updated;
    }

    const id = await ctx.db.insert("fashion_profiles", {
      ownerId,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(gender !== undefined ? { gender } : {}),
      ...(hasSizes ? { sizes } : {}),
      ...(stylePreferences !== undefined ? { stylePreferences } : {}),
      hasBodyPhoto: false,
      updatedAt: now,
    });
    const profile = await ctx.db.get(id);
    if (!profile) throw new ConvexError({ code: "INTERNAL_ERROR", message: "Profile insert failed" });
    return profile;
  },
});

export const setBodyPhotoFlag = mutation({
  args: {
    hasBodyPhoto: v.boolean(),
    bodyPhotoMimeType: v.optional(v.string()),
  },
  returns: fashion_profile_validator,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "fashion_set_body_photo_flag",
      ownerId,
      RATE_SETTINGS,
      "Too many body photo updates. Wait a moment and try again.",
    );
    const mimeType = optionalText(args.bodyPhotoMimeType, "bodyPhotoMimeType", 80);
    const now = Date.now();

    const existing = await getProfileForOwner(ctx, ownerId);
    if (existing) {
      await ctx.db.patch(existing._id, {
        hasBodyPhoto: args.hasBodyPhoto,
        ...(args.hasBodyPhoto
          ? {
              bodyPhotoMimeType: mimeType ?? existing.bodyPhotoMimeType,
              bodyPhotoUpdatedAt: now,
            }
          : {
              bodyPhotoMimeType: undefined,
              bodyPhotoUpdatedAt: undefined,
            }),
        updatedAt: now,
      });
      const updated = await ctx.db.get(existing._id);
      if (!updated) throw new ConvexError({ code: "INTERNAL_ERROR", message: "Profile vanished" });
      return updated;
    }

    const id = await ctx.db.insert("fashion_profiles", {
      ownerId,
      hasBodyPhoto: args.hasBodyPhoto,
      ...(args.hasBodyPhoto
        ? {
            ...(mimeType ? { bodyPhotoMimeType: mimeType } : {}),
            bodyPhotoUpdatedAt: now,
          }
        : {}),
      updatedAt: now,
    });
    const profile = await ctx.db.get(id);
    if (!profile) throw new ConvexError({ code: "INTERNAL_ERROR", message: "Profile insert failed" });
    return profile;
  },
});

// ---------------------------------------------------------------------------
// Outfits
// ---------------------------------------------------------------------------

const normalizeProduct = (
  raw: unknown,
  index: number,
) => {
  if (!raw || typeof raw !== "object") {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: `products[${index}] is required`,
    });
  }
  const r = raw as Record<string, unknown>;
  const slot = requiredText(trim(r.slot), `products[${index}].slot`, 32);
  const productId = requiredText(trim(r.productId), `products[${index}].productId`, MAX_ID);
  const variantId = requiredText(trim(r.variantId), `products[${index}].variantId`, MAX_ID);
  const title = requiredText(trim(r.title), `products[${index}].title`, MAX_TITLE);
  const merchantOrigin = requiredText(
    trim(r.merchantOrigin),
    `products[${index}].merchantOrigin`,
    MAX_MERCHANT,
  );
  const price =
    typeof r.price === "number" && Number.isFinite(r.price) ? r.price : undefined;
  const currency = optionalText(
    typeof r.currency === "string" ? r.currency : undefined,
    `products[${index}].currency`,
    16,
  );
  const imageUrl = optionalText(
    typeof r.imageUrl === "string" ? r.imageUrl : undefined,
    `products[${index}].imageUrl`,
    MAX_URL,
  );
  const productUrl = optionalText(
    typeof r.productUrl === "string" ? r.productUrl : undefined,
    `products[${index}].productUrl`,
    MAX_URL,
  );
  const checkoutUrl = optionalText(
    typeof r.checkoutUrl === "string" ? r.checkoutUrl : undefined,
    `products[${index}].checkoutUrl`,
    MAX_URL,
  );
  const vendor = optionalText(
    typeof r.vendor === "string" ? r.vendor : undefined,
    `products[${index}].vendor`,
    MAX_VENDOR,
  );
  return {
    slot,
    productId,
    variantId,
    title,
    merchantOrigin,
    ...(price !== undefined ? { price } : {}),
    ...(currency ? { currency } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(productUrl ? { productUrl } : {}),
    ...(checkoutUrl ? { checkoutUrl } : {}),
    ...(vendor ? { vendor } : {}),
  };
};

export const listOutfits = query({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(fashion_outfit_validator),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 60), 1), 200);
    return await ctx.db
      .query("fashion_outfits")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(limit);
  },
});

export const listOutfitsByBatch = query({
  args: { batchId: v.string() },
  returns: v.array(fashion_outfit_validator),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const batchId = requiredText(args.batchId, "batchId", MAX_BATCH_ID);
    return await ctx.db
      .query("fashion_outfits")
      .withIndex("by_ownerId_and_batchId", (q) =>
        q.eq("ownerId", ownerId).eq("batchId", batchId),
      )
      .collect();
  },
});

export const insertOutfit = internalMutation({
  args: {
    ownerId: v.string(),
    batchId: v.string(),
    ordinal: v.number(),
    stylePrompt: v.optional(v.string()),
    themeLabel: v.string(),
    themeDescription: v.optional(v.string()),
    products: v.array(fashion_outfit_product_validator),
    tryOnPrompt: v.optional(v.string()),
  },
  returns: v.id("fashion_outfits"),
  handler: async (ctx, args) => {
    const batchId = requiredText(args.batchId, "batchId", MAX_BATCH_ID);
    if (!Number.isFinite(args.ordinal) || args.ordinal < 0) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: "ordinal must be non-negative" });
    }
    const themeLabel = requiredText(args.themeLabel, "themeLabel", MAX_THEME_LABEL);
    const themeDescription = optionalText(
      args.themeDescription,
      "themeDescription",
      MAX_THEME_DESCRIPTION,
    );
    const stylePrompt = optionalText(args.stylePrompt, "stylePrompt", MAX_PROMPT);
    const tryOnPrompt = optionalText(args.tryOnPrompt, "tryOnPrompt", MAX_PROMPT);

    // Empty `products` is allowed: the user-driven Try-On flow registers an
    // outfit that's just the rendered image (no shoppable products attached).
    // The Shopify outfit-builder agent always submits ≥1 product.
    if (args.products.length > MAX_PRODUCTS_PER_OUTFIT) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Too many products in outfit (max ${MAX_PRODUCTS_PER_OUTFIT})`,
      });
    }

    const products = args.products.map((p, i) => normalizeProduct(p, i));
    const now = Date.now();

    const existingForBatch = await ctx.db
      .query("fashion_outfits")
      .withIndex("by_ownerId_and_batchId", (q) =>
        q.eq("ownerId", args.ownerId).eq("batchId", batchId),
      )
      .collect();
    if (existingForBatch.length >= MAX_OUTFITS_PER_BATCH) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Batch already has ${existingForBatch.length} outfits (cap ${MAX_OUTFITS_PER_BATCH})`,
      });
    }

    return await ctx.db.insert("fashion_outfits", {
      ownerId: args.ownerId,
      batchId,
      ordinal: Math.floor(args.ordinal),
      status: "generating",
      ...(stylePrompt ? { stylePrompt } : {}),
      themeLabel,
      ...(themeDescription ? { themeDescription } : {}),
      products,
      ...(tryOnPrompt ? { tryOnPrompt } : {}),
      createdAt: now,
    });
  },
});

export const markOutfitReady = internalMutation({
  args: {
    ownerId: v.string(),
    outfitId: v.id("fashion_outfits"),
    tryOnImagePath: v.optional(v.string()),
    tryOnImageUrl: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const outfit = await ctx.db.get(args.outfitId);
    if (!outfit) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Outfit not found" });
    }
    if (outfit.ownerId !== args.ownerId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Outfit not found" });
    }
    const tryOnImagePath = optionalText(args.tryOnImagePath, "tryOnImagePath", MAX_URL);
    const tryOnImageUrl = optionalText(args.tryOnImageUrl, "tryOnImageUrl", MAX_URL);
    await ctx.db.patch(args.outfitId, {
      status: "ready",
      ...(tryOnImagePath ? { tryOnImagePath } : {}),
      ...(tryOnImageUrl ? { tryOnImageUrl } : {}),
      readyAt: Date.now(),
    });
    return null;
  },
});

export const markOutfitFailed = internalMutation({
  args: {
    ownerId: v.string(),
    outfitId: v.id("fashion_outfits"),
    errorMessage: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const outfit = await ctx.db.get(args.outfitId);
    if (!outfit) return null;
    if (outfit.ownerId !== args.ownerId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Outfit not found" });
    }
    const errorMessage = requiredText(args.errorMessage, "errorMessage", 500);
    await ctx.db.patch(args.outfitId, {
      status: "failed",
      errorMessage,
      readyAt: Date.now(),
    });
    return null;
  },
});

export const deleteOutfit = mutation({
  args: { outfitId: v.id("fashion_outfits") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "fashion_delete_outfit",
      ownerId,
      RATE_HOT_PATH,
    );
    const outfit = await ctx.db.get(args.outfitId);
    if (!outfit || outfit.ownerId !== ownerId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Outfit not found" });
    }
    await ctx.db.delete(args.outfitId);
    return null;
  },
});

export const getRecentOutfitProductIdsInternal = internalQuery({
  args: {
    ownerId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 30), 1), 100);
    const recent = await ctx.db
      .query("fashion_outfits")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(limit);
    const ids = new Set<string>();
    for (const outfit of recent) {
      for (const product of outfit.products) {
        ids.add(product.productId);
      }
    }
    return Array.from(ids);
  },
});

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

export const listLikes = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(fashion_like_validator),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 100), 1), 500);
    return await ctx.db
      .query("fashion_likes")
      .withIndex("by_ownerId_and_likedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(limit);
  },
});

const likeProductInputs = {
  variantId: v.string(),
  productId: v.string(),
  title: v.string(),
  imageUrl: v.optional(v.string()),
  productUrl: v.optional(v.string()),
  merchantOrigin: v.string(),
  priceCents: v.optional(v.number()),
  currency: v.optional(v.string()),
  vendor: v.optional(v.string()),
};

export const toggleLike = mutation({
  args: likeProductInputs,
  returns: v.object({
    liked: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "fashion_toggle_like",
      ownerId,
      RATE_HOT_PATH,
    );

    const variantId = requiredText(args.variantId, "variantId", MAX_ID);
    const productId = requiredText(args.productId, "productId", MAX_ID);
    const title = requiredText(args.title, "title", MAX_TITLE);
    const merchantOrigin = requiredText(
      args.merchantOrigin,
      "merchantOrigin",
      MAX_MERCHANT,
    );

    const existing = await ctx.db
      .query("fashion_likes")
      .withIndex("by_ownerId_and_variantId", (q) =>
        q.eq("ownerId", ownerId).eq("variantId", variantId),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { liked: false };
    }

    await ctx.db.insert("fashion_likes", {
      ownerId,
      variantId,
      productId,
      title,
      merchantOrigin,
      ...(args.imageUrl
        ? { imageUrl: optionalText(args.imageUrl, "imageUrl", MAX_URL) }
        : {}),
      ...(args.productUrl
        ? { productUrl: optionalText(args.productUrl, "productUrl", MAX_URL) }
        : {}),
      ...(typeof args.priceCents === "number"
        ? { priceCents: Math.floor(args.priceCents) }
        : {}),
      ...(args.currency
        ? { currency: optionalText(args.currency, "currency", 16) }
        : {}),
      ...(args.vendor ? { vendor: optionalText(args.vendor, "vendor", MAX_VENDOR) } : {}),
      likedAt: Date.now(),
    });
    return { liked: true };
  },
});

export const getRecentLikesForOwnerInternal = internalQuery({
  args: { ownerId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(fashion_like_validator),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 30), 1), 100);
    return await ctx.db
      .query("fashion_likes")
      .withIndex("by_ownerId_and_likedAt", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(limit);
  },
});

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export const listCart = query({
  args: {},
  returns: v.array(fashion_cart_item_validator),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await ctx.db
      .query("fashion_cart_items")
      .withIndex("by_ownerId_and_addedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(200);
  },
});

export const addToCart = mutation({
  args: {
    ...likeProductInputs,
    checkoutUrl: v.optional(v.string()),
    quantity: v.optional(v.number()),
  },
  returns: fashion_cart_item_validator,
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "fashion_add_to_cart",
      ownerId,
      RATE_STANDARD,
    );
    const variantId = requiredText(args.variantId, "variantId", MAX_ID);
    const productId = requiredText(args.productId, "productId", MAX_ID);
    const title = requiredText(args.title, "title", MAX_TITLE);
    const merchantOrigin = requiredText(
      args.merchantOrigin,
      "merchantOrigin",
      MAX_MERCHANT,
    );
    const quantity = Math.max(1, Math.min(99, Math.floor(args.quantity ?? 1)));

    const existing = await ctx.db
      .query("fashion_cart_items")
      .withIndex("by_ownerId_and_variantId", (q) =>
        q.eq("ownerId", ownerId).eq("variantId", variantId),
      )
      .unique();

    if (existing) {
      const next = Math.max(1, Math.min(99, existing.quantity + quantity));
      await ctx.db.patch(existing._id, { quantity: next });
      const updated = await ctx.db.get(existing._id);
      if (!updated) {
        throw new ConvexError({ code: "INTERNAL_ERROR", message: "Cart vanished" });
      }
      return updated;
    }

    const id = await ctx.db.insert("fashion_cart_items", {
      ownerId,
      variantId,
      productId,
      title,
      merchantOrigin,
      ...(args.imageUrl
        ? { imageUrl: optionalText(args.imageUrl, "imageUrl", MAX_URL) }
        : {}),
      ...(args.productUrl
        ? { productUrl: optionalText(args.productUrl, "productUrl", MAX_URL) }
        : {}),
      ...(args.checkoutUrl
        ? { checkoutUrl: optionalText(args.checkoutUrl, "checkoutUrl", MAX_URL) }
        : {}),
      ...(typeof args.priceCents === "number"
        ? { priceCents: Math.floor(args.priceCents) }
        : {}),
      ...(args.currency
        ? { currency: optionalText(args.currency, "currency", 16) }
        : {}),
      ...(args.vendor ? { vendor: optionalText(args.vendor, "vendor", MAX_VENDOR) } : {}),
      quantity,
      addedAt: Date.now(),
    });
    const item = await ctx.db.get(id);
    if (!item) {
      throw new ConvexError({ code: "INTERNAL_ERROR", message: "Cart insert failed" });
    }
    return item;
  },
});

export const removeFromCart = mutation({
  args: { cartItemId: v.id("fashion_cart_items") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "fashion_remove_from_cart",
      ownerId,
      RATE_HOT_PATH,
    );
    const item = await ctx.db.get(args.cartItemId);
    if (!item || item.ownerId !== ownerId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Cart item not found" });
    }
    await ctx.db.delete(args.cartItemId);
    return null;
  },
});

export const setCartQuantity = mutation({
  args: {
    cartItemId: v.id("fashion_cart_items"),
    quantity: v.number(),
  },
  returns: v.union(v.null(), fashion_cart_item_validator),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "fashion_set_cart_quantity",
      ownerId,
      RATE_HOT_PATH,
    );
    const item = await ctx.db.get(args.cartItemId);
    if (!item || item.ownerId !== ownerId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Cart item not found" });
    }
    const next = Math.floor(args.quantity);
    if (next <= 0) {
      await ctx.db.delete(args.cartItemId);
      return null;
    }
    await ctx.db.patch(args.cartItemId, { quantity: Math.min(99, next) });
    return await ctx.db.get(args.cartItemId);
  },
});

export const getCartForOwnerInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(fashion_cart_item_validator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("fashion_cart_items")
      .withIndex("by_ownerId_and_addedAt", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(200);
  },
});

// ---------------------------------------------------------------------------
// Checkout sessions (persisted for "open in store" + retry)
// ---------------------------------------------------------------------------

export const recordCheckoutSession = internalMutation({
  args: {
    ownerId: v.string(),
    merchantOrigin: v.string(),
    mcpEndpoint: v.optional(v.string()),
    checkoutId: v.string(),
    status: v.string(),
    continueUrl: v.optional(v.string()),
    rawResponse: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  returns: v.id("fashion_checkout_sessions"),
  handler: async (ctx, args) => {
    const merchantOrigin = requiredText(args.merchantOrigin, "merchantOrigin", MAX_MERCHANT);
    const checkoutId = requiredText(args.checkoutId, "checkoutId", MAX_ID);
    const status = requiredText(args.status, "status", 64);
    const mcpEndpoint = optionalText(args.mcpEndpoint, "mcpEndpoint", MAX_URL);
    const continueUrl = optionalText(args.continueUrl, "continueUrl", MAX_URL);
    const rawResponse = optionalText(args.rawResponse, "rawResponse", 64_000);
    const now = Date.now();
    return await ctx.db.insert("fashion_checkout_sessions", {
      ownerId: args.ownerId,
      merchantOrigin,
      ...(mcpEndpoint ? { mcpEndpoint } : {}),
      checkoutId,
      status,
      ...(continueUrl ? { continueUrl } : {}),
      ...(rawResponse ? { rawResponse } : {}),
      ...(typeof args.expiresAt === "number" ? { expiresAt: args.expiresAt } : {}),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateCheckoutSession = internalMutation({
  args: {
    sessionId: v.id("fashion_checkout_sessions"),
    status: v.optional(v.string()),
    continueUrl: v.optional(v.string()),
    rawResponse: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    await ctx.db.patch(args.sessionId, {
      ...(args.status
        ? { status: requiredText(args.status, "status", 64) }
        : {}),
      ...(args.continueUrl
        ? { continueUrl: optionalText(args.continueUrl, "continueUrl", MAX_URL) }
        : {}),
      ...(args.rawResponse
        ? { rawResponse: optionalText(args.rawResponse, "rawResponse", 64_000) }
        : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

// Surfaced for the orchestrator-spawned fashion agent so it doesn't have to
// rebuild like-context from raw model state.
export type FashionContextSummary = {
  profile: {
    gender?: string;
    sizes?: Record<string, string>;
    stylePreferences?: string;
  } | null;
  recentLikes: Array<{ productId: string; title: string; vendor?: string }>;
  cart: Array<{ productId: string; title: string; quantity: number }>;
  recentOutfitProductIds: string[];
};

export const getOrchestratorContextInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.object({
    profile: v.union(
      v.null(),
      v.object({
        gender: v.optional(v.string()),
        sizes: v.optional(fashion_sizes_validator),
        stylePreferences: v.optional(v.string()),
      }),
    ),
    recentLikes: v.array(
      v.object({
        productId: v.string(),
        title: v.string(),
        vendor: v.optional(v.string()),
      }),
    ),
    cart: v.array(
      v.object({
        productId: v.string(),
        title: v.string(),
        quantity: v.number(),
      }),
    ),
    recentOutfitProductIds: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const profile = await getProfileForOwner(ctx, args.ownerId);
    const likes = await ctx.db
      .query("fashion_likes")
      .withIndex("by_ownerId_and_likedAt", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(30);
    const cart = await ctx.db
      .query("fashion_cart_items")
      .withIndex("by_ownerId_and_addedAt", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(50);
    const recentOutfits = await ctx.db
      .query("fashion_outfits")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(20);
    const productIds = new Set<string>();
    for (const outfit of recentOutfits) {
      for (const product of outfit.products) {
        productIds.add(product.productId);
      }
    }
    return {
      profile: profile
        ? {
            ...(profile.gender ? { gender: profile.gender } : {}),
            ...(profile.sizes ? { sizes: profile.sizes } : {}),
            ...(profile.stylePreferences
              ? { stylePreferences: profile.stylePreferences }
              : {}),
          }
        : null,
      recentLikes: likes.map((l) => ({
        productId: l.productId,
        title: l.title,
        ...(l.vendor ? { vendor: l.vendor } : {}),
      })),
      cart: cart.map((c) => ({
        productId: c.productId,
        title: c.title,
        quantity: c.quantity,
      })),
      recentOutfitProductIds: Array.from(productIds),
    };
  },
});
