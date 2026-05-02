import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import { ConvexError, v } from "convex/values";
import {
  socialProfileValidator,
  ensureSocialProfileDoc,
  getSocialProfileByOwnerId,
  normalizeNickname,
  normalizeNicknameKey,
  normalizePublicHandle,
} from "./shared";
import {
  requireBoundedString,
} from "../shared_validators";
import {
  getConnectedUserIdOrNull,
  requireConnectedUserId,
} from "../auth";
import {
  enforceMutationRateLimit,
  RATE_SETTINGS,
  RATE_STANDARD,
} from "../lib/rate_limits";
import { findBannedTerm } from "./censor";

const optionalProfileValidator = v.union(v.null(), socialProfileValidator);

const creatorProfileSummaryValidator = v.object({
  publicHandle: v.string(),
  displayName: v.string(),
});

const syncStoreAuthorProfile = async (
  ctx: MutationCtx,
  ownerId: string,
  profile: { publicHandle: string; nickname: string },
) => {
  const packages = await ctx.db
    .query("store_packages")
    .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
    .take(500);
  await Promise.all(
    packages.map((pkg) =>
      ctx.db.patch(pkg._id, {
        authorHandle: profile.publicHandle,
        authorDisplayName: profile.nickname,
      }),
    ),
  );
};

/**
 * Public DTO returned by friend-code lookups. Intentionally omits `ownerId`
 * and `_id` so a caller who learns or guesses a friend code cannot use this
 * endpoint to enumerate canonical owner identifiers; only display fields the
 * profile owner has chosen to expose are returned.
 */
const publicProfileByFriendCodeValidator = v.union(
  v.null(),
  v.object({
    nickname: v.string(),
    friendCode: v.string(),
    avatarUrl: v.optional(v.string()),
  }),
);

export const ensureProfileInternal = internalMutation({
  args: {},
  returns: socialProfileValidator,
  handler: async (ctx) => {
    const ownerId = await requireConnectedUserId(ctx);
    return await ensureSocialProfileDoc(ctx, ownerId);
  },
});

export const ensureProfileForOwnerInternal = internalMutation({
  args: { ownerId: v.string() },
  returns: socialProfileValidator,
  handler: async (ctx, args) => {
    const profile = await ensureSocialProfileDoc(ctx, args.ownerId);
    await syncStoreAuthorProfile(ctx, args.ownerId, profile);
    return profile;
  },
});

export const getProfileByOwnerIdInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: optionalProfileValidator,
  handler: async (ctx, args) => {
    return await getSocialProfileByOwnerId(ctx, args.ownerId);
  },
});

export const ensureProfile = mutation({
  args: {},
  returns: socialProfileValidator,
  handler: async (ctx) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "social_ensure_profile",
      ownerId,
      RATE_STANDARD,
    );
    return await ensureSocialProfileDoc(ctx, ownerId);
  },
});

export const getMyProfile = query({
  args: {},
  returns: optionalProfileValidator,
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || (identity as Record<string, unknown>).isAnonymous === true) {
      return null;
    }
    return await getSocialProfileByOwnerId(ctx, identity.tokenIdentifier);
  },
});

export const getProfileByHandle = query({
  args: { handle: v.string() },
  returns: v.union(v.null(), creatorProfileSummaryValidator),
  handler: async (ctx, args) => {
    const handle = args.handle.trim().toLowerCase();
    if (!handle) return null;
    const profile = await ctx.db
      .query("social_profiles")
      .withIndex("by_publicHandle", (q) => q.eq("publicHandle", handle))
      .unique();
    if (!profile) return null;
    return {
      publicHandle: profile.publicHandle,
      displayName: profile.nickname,
    };
  },
});

export const claimHandle = mutation({
  args: { handle: v.string() },
  returns: creatorProfileSummaryValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "social_claim_handle",
      ownerId,
      RATE_SETTINGS,
      "Too many handle updates. Please wait a moment and try again.",
    );
    const publicHandle = normalizePublicHandle(args.handle);
    const profile = await ensureSocialProfileDoc(ctx, ownerId);
    const collision = await ctx.db
      .query("social_profiles")
      .withIndex("by_publicHandle", (q) => q.eq("publicHandle", publicHandle))
      .unique();
    if (collision && collision.ownerId !== ownerId) {
      throw new ConvexError({
        code: "HANDLE_TAKEN",
        message: "That handle is taken. Pick a different one.",
      });
    }
    if (profile.publicHandle !== publicHandle) {
      await ctx.db.patch(profile._id, {
        publicHandle,
        updatedAt: Date.now(),
      });
      await syncStoreAuthorProfile(ctx, ownerId, {
        publicHandle,
        nickname: profile.nickname,
      });
    }
    return {
      publicHandle,
      displayName: profile.nickname,
    };
  },
});

export const getProfileByFriendCode = query({
  args: { friendCode: v.string() },
  returns: publicProfileByFriendCodeValidator,
  handler: async (ctx, args) => {
    await requireConnectedUserId(ctx);
    const code = args.friendCode.trim().toUpperCase();
    if (!code) {
      return null;
    }
    const profile = await ctx.db
      .query("social_profiles")
      .withIndex("by_friendCode", (q) => q.eq("friendCode", code))
      .unique();
    if (!profile) {
      return null;
    }
    return {
      nickname: profile.nickname,
      friendCode: profile.friendCode,
      avatarUrl: profile.avatarUrl,
    };
  },
});

/**
 * Bulk-resolve public display info for an arbitrary set of owner ids. Used by
 * the Global Chat pane to render sender names/avatars for messages whose
 * authors aren't part of any small membership row set. Intentionally omits
 * `friendCode` so a user's add-handle isn't exposed to everyone in a public
 * room — friend requests in this surface go through `sendFriendRequestByOwnerId`.
 */
export const getProfilesByOwnerIds = query({
  args: {
    ownerIds: v.array(v.string()),
  },
  returns: v.array(
    v.object({
      ownerId: v.string(),
      nickname: v.string(),
      avatarUrl: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const callerId = await getConnectedUserIdOrNull(ctx);
    if (!callerId) {
      return [];
    }
    const unique = [...new Set(args.ownerIds)].slice(0, 256);
    const profiles = await Promise.all(
      unique.map((ownerId) => getSocialProfileByOwnerId(ctx, ownerId)),
    );
    return profiles
      .filter((profile): profile is NonNullable<typeof profile> =>
        Boolean(profile),
      )
      .map((profile) => ({
        ownerId: profile.ownerId,
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
      }));
  },
});

export const updateMyProfile = mutation({
  args: {
    nickname: v.optional(v.string()),
    avatarUrl: v.optional(v.union(v.string(), v.null())),
  },
  returns: socialProfileValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "social_update_my_profile",
      ownerId,
      RATE_SETTINGS,
      "Too many profile updates. Please wait a moment and try again.",
    );
    const profile = await ensureSocialProfileDoc(ctx, ownerId);

    const patch: {
      nickname?: string;
      nicknameNormalized?: string;
      avatarUrl?: string | undefined;
      updatedAt: number;
    } = {
      updatedAt: Date.now(),
    };

    if (args.nickname !== undefined) {
      const nickname = normalizeNickname(args.nickname);
      if (!nickname) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "Nickname is required.",
        });
      }
      requireBoundedString(nickname, "nickname", 40);
      if (findBannedTerm(nickname) !== null) {
        throw new ConvexError({
          code: "PROFANITY_BLOCKED",
          message:
            "That display name contains a banned word. Please pick a different one.",
        });
      }
      patch.nickname = nickname;
      patch.nicknameNormalized = normalizeNicknameKey(nickname);
    }

    if (args.avatarUrl !== undefined) {
      const nextAvatarUrl = args.avatarUrl?.trim();
      if (nextAvatarUrl) {
        requireBoundedString(nextAvatarUrl, "avatarUrl", 2000);
        patch.avatarUrl = nextAvatarUrl;
      } else {
        patch.avatarUrl = undefined;
      }
    }

    await ctx.db.patch(profile._id, patch);
    const updated = await ctx.db.get(profile._id);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to update social profile",
      });
    }
    await syncStoreAuthorProfile(ctx, ownerId, updated);
    return updated;
  },
});
