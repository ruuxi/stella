import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { ConvexError, v } from "convex/values";
import {
  socialProfileValidator,
  ensureSocialProfileDoc,
  getSocialProfileByOwnerId,
  normalizeNickname,
  normalizeNicknameKey,
} from "./shared";
import {
  requireBoundedString,
} from "../shared_validators";
import {
  requireConnectedUserId,
} from "../auth";

const optionalProfileValidator = v.union(v.null(), socialProfileValidator);

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

export const updateMyProfile = mutation({
  args: {
    nickname: v.optional(v.string()),
    avatarUrl: v.optional(v.union(v.string(), v.null())),
  },
  returns: socialProfileValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
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
    return updated;
  },
});
