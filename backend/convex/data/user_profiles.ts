/**
 * Public creator profile management.
 *
 * One profile per user. The `publicHandle` is the URL-stable slug used
 * by `/c/:handle` and by `release.parent.authorHandle` references.
 *
 * Uniqueness is enforced inside the mutation by checking the
 * `by_publicHandle` index in the same transaction — Convex's indexes
 * don't enforce uniqueness declaratively.
 */

import { ConvexError, v } from "convex/values";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { requireSensitiveUserId, requireUserId } from "../auth";
import { enforceMutationRateLimit, RATE_SENSITIVE } from "../lib/rate_limits";

const HANDLE_REGEX = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])$/;
const RESERVED_HANDLES = new Set([
  "admin",
  "stella",
  "store",
  "creator",
  "creators",
  "support",
  "help",
  "about",
  "settings",
]);

const normalizeHandle = (raw: string): string => {
  const normalized = raw.trim().toLowerCase();
  if (!HANDLE_REGEX.test(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message:
        "Handle must be 3-32 lowercase letters/numbers/underscores/hyphens, and start + end with a letter or number.",
    });
  }
  if (RESERVED_HANDLES.has(normalized)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "That handle is reserved. Pick a different one.",
    });
  }
  return normalized;
};

const findByOwnerId = async (ctx: QueryCtx | MutationCtx, ownerId: string) =>
  await ctx.db
    .query("user_profiles")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();

const findByHandle = async (
  ctx: QueryCtx | MutationCtx,
  handle: string,
) =>
  await ctx.db
    .query("user_profiles")
    .withIndex("by_publicHandle", (q) => q.eq("publicHandle", handle))
    .unique();

export const getMyProfile = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("user_profiles"),
      _creationTime: v.number(),
      ownerId: v.string(),
      publicHandle: v.string(),
      displayName: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    return await findByOwnerId(ctx, ownerId);
  },
});

const profileSummaryValidator = v.object({
  publicHandle: v.string(),
  displayName: v.optional(v.string()),
});

export const getProfileByHandle = query({
  args: { handle: v.string() },
  returns: v.union(v.null(), profileSummaryValidator),
  handler: async (ctx, args) => {
    const normalized = args.handle.trim().toLowerCase();
    if (!HANDLE_REGEX.test(normalized)) return null;
    const profile = await findByHandle(ctx, normalized);
    if (!profile) return null;
    return {
      publicHandle: profile.publicHandle,
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
    };
  },
});

export const claimHandle = mutation({
  args: {
    handle: v.string(),
    displayName: v.optional(v.string()),
  },
  returns: v.object({
    publicHandle: v.string(),
    displayName: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSensitiveUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "user_profiles_claim_handle",
      ownerId,
      RATE_SENSITIVE,
      "Too many handle claim attempts. Wait a moment and try again.",
    );
    const handle = normalizeHandle(args.handle);

    // If the user already owns this handle, treat as a no-op + display
    // name update. If they own a different handle, refuse — handle
    // changes need a deliberate "rename" path we haven't designed yet.
    const existing = await findByOwnerId(ctx, ownerId);
    if (existing && existing.publicHandle !== handle) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message:
          "You already have a creator handle. Renaming isn't supported yet.",
      });
    }

    // Uniqueness check inside the mutation transaction.
    const collision = await findByHandle(ctx, handle);
    if (collision && collision.ownerId !== ownerId) {
      throw new ConvexError({
        code: "HANDLE_TAKEN",
        message: "That handle is taken. Pick a different one.",
      });
    }

    const trimmedName = args.displayName?.trim();
    const displayName = trimmedName && trimmedName.length > 0 ? trimmedName : undefined;
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...(displayName ? { displayName } : {}),
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("user_profiles", {
        ownerId,
        publicHandle: handle,
        ...(displayName ? { displayName } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      publicHandle: handle,
      ...(displayName ? { displayName } : {}),
    };
  },
});

/**
 * Internal: resolve `ownerId -> publicHandle` for one user. Used by
 * `confirmDraft` to stamp the parent ref's `authorHandle` and by the
 * package surface to populate creator bylines.
 */
export const getHandleForOwnerInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const profile = await findByOwnerId(ctx, args.ownerId);
    return profile?.publicHandle ?? null;
  },
});
