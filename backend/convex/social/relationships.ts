import {
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { ConvexError, v } from "convex/values";
import {
  socialProfileValidator,
  socialRelationshipValidator,
  ensureRelationshipIsAccepted,
  ensureSocialProfileDoc,
  getRelationshipKey,
  getSocialProfileByOwnerId,
  listAcceptedRelationshipsForOwner,
  loadRelationship,
} from "./shared";
import {
  getConnectedUserIdOrNull,
  requireConnectedUserId,
} from "../auth";
import {
  enforceMutationRateLimit,
  RATE_STANDARD,
  RATE_VERY_EXPENSIVE,
} from "../lib/rate_limits";

const socialFriendSummaryValidator = v.object({
  relationship: socialRelationshipValidator,
  profile: socialProfileValidator,
});

const socialPendingRequestSummaryValidator = v.object({
  relationship: socialRelationshipValidator,
  profile: socialProfileValidator,
  direction: v.union(v.literal("incoming"), v.literal("outgoing")),
});

const hydrateRelationshipPeer = async (
  ctx: Parameters<typeof listAcceptedRelationshipsForOwner>[0],
  ownerId: string,
  relationship: {
    lowOwnerId: string;
    highOwnerId: string;
  },
) => {
  const peerOwnerId =
    relationship.lowOwnerId === ownerId
      ? relationship.highOwnerId
      : relationship.lowOwnerId;
  return await getSocialProfileByOwnerId(ctx, peerOwnerId);
};

export const listFriends = query({
  args: {},
  returns: v.array(socialFriendSummaryValidator),
  handler: async (ctx) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
    const relationships = await listAcceptedRelationshipsForOwner(ctx, ownerId);
    const friends = await Promise.all(
      relationships.map(async (relationship) => {
        const profile = await hydrateRelationshipPeer(ctx, ownerId, relationship);
        return profile ? { relationship, profile } : null;
      }),
    );
    return friends.filter((entry): entry is (typeof friends)[number] & NonNullable<typeof entry> => Boolean(entry));
  },
});

export const listPendingRequests = query({
  args: {},
  returns: v.array(socialPendingRequestSummaryValidator),
  handler: async (ctx) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
    // Pending lists are typically small; cap the scan to keep the query
    // bounded even for prolific senders/receivers.
    const MAX_PENDING_REQUESTS_PER_SIDE = 200;
    const [incoming, outgoing] = await Promise.all([
      ctx.db
        .query("social_relationships")
        .withIndex("by_addresseeOwnerId_and_status", (q) =>
          q.eq("addresseeOwnerId", ownerId).eq("status", "pending"),
        )
        .take(MAX_PENDING_REQUESTS_PER_SIDE),
      ctx.db
        .query("social_relationships")
        .withIndex("by_requesterOwnerId_and_status", (q) =>
          q.eq("requesterOwnerId", ownerId).eq("status", "pending"),
        )
        .take(MAX_PENDING_REQUESTS_PER_SIDE),
    ]);

    const entries = await Promise.all(
      [...incoming.map((relationship) => ({ relationship, direction: "incoming" as const })), ...outgoing.map((relationship) => ({ relationship, direction: "outgoing" as const }))]
        .map(async (entry) => {
          const profile = await hydrateRelationshipPeer(ctx, ownerId, entry.relationship);
          return profile ? { ...entry, profile } : null;
        }),
    );
    return entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  },
});

/**
 * Shared helper that produces (or revives) a pending friend-request row from
 * the caller to `targetOwnerId`. The two `sendFriendRequest*` mutations both
 * rate-limit + resolve their target profile before delegating here.
 */
const upsertPendingFriendRequest = async (
  ctx: MutationCtx,
  ownerId: string,
  targetOwnerId: string,
): Promise<Doc<"social_relationships">> => {
  if (targetOwnerId === ownerId) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "You cannot friend yourself",
    });
  }

  const existing = await loadRelationship(ctx, ownerId, targetOwnerId);
  if (existing) {
    if (existing.status === "accepted" || existing.status === "pending") {
      return existing;
    }
    await ctx.db.patch(existing._id, {
      requesterOwnerId: ownerId,
      addresseeOwnerId: targetOwnerId,
      initiatedByOwnerId: ownerId,
      status: "pending",
      updatedAt: Date.now(),
      respondedAt: undefined,
    });
    const updated = await ctx.db.get(existing._id);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to update friend request",
      });
    }
    return updated;
  }

  const now = Date.now();
  const sorted = [ownerId, targetOwnerId].sort((a, b) => a.localeCompare(b));
  const id = await ctx.db.insert("social_relationships", {
    relationshipKey: getRelationshipKey(ownerId, targetOwnerId),
    lowOwnerId: sorted[0]!,
    highOwnerId: sorted[1]!,
    requesterOwnerId: ownerId,
    addresseeOwnerId: targetOwnerId,
    initiatedByOwnerId: ownerId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  const created = await ctx.db.get(id);
  if (!created) {
    throw new ConvexError({
      code: "INTERNAL_ERROR",
      message: "Failed to create friend request",
    });
  }
  return created;
};

export const sendFriendRequest = mutation({
  args: {
    friendCode: v.string(),
  },
  returns: socialRelationshipValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    // Friend-request spam vector: cap aggressively per owner so a malicious
    // client can't enumerate friend codes or harass other users.
    await enforceMutationRateLimit(
      ctx,
      "social_send_friend_request",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many friend requests. Please wait a minute before trying again.",
    );
    await ensureSocialProfileDoc(ctx, ownerId);
    const code = args.friendCode.trim().toUpperCase();
    if (!code) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "friendCode is required",
      });
    }

    const targetProfile = await ctx.db
      .query("social_profiles")
      .withIndex("by_friendCode", (q) => q.eq("friendCode", code))
      .unique();
    if (!targetProfile) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "No user found for that friend code",
      });
    }

    return await upsertPendingFriendRequest(ctx, ownerId, targetProfile.ownerId);
  },
});

/**
 * Sends a friend request directly to a known owner id (e.g. clicking a sender
 * in Global Chat). The caller has not seen the target's friend code; we
 * therefore only allow this when the target already has a social profile.
 */
export const sendFriendRequestByOwnerId = mutation({
  args: {
    targetOwnerId: v.string(),
  },
  returns: socialRelationshipValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "social_send_friend_request",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many friend requests. Please wait a minute before trying again.",
    );
    await ensureSocialProfileDoc(ctx, ownerId);

    const targetOwnerId = args.targetOwnerId.trim();
    if (!targetOwnerId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "targetOwnerId is required",
      });
    }
    const targetProfile = await getSocialProfileByOwnerId(ctx, targetOwnerId);
    if (!targetProfile) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "User not found",
      });
    }

    return await upsertPendingFriendRequest(ctx, ownerId, targetProfile.ownerId);
  },
});

export const respondToFriendRequest = mutation({
  args: {
    requesterOwnerId: v.string(),
    action: v.union(v.literal("accept"), v.literal("decline"), v.literal("block")),
  },
  returns: socialRelationshipValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "social_respond_to_friend_request",
      ownerId,
      RATE_STANDARD,
      "Too many requests. Please slow down and try again.",
    );
    const relationship = await loadRelationship(ctx, ownerId, args.requesterOwnerId);
    if (!relationship || relationship.addresseeOwnerId !== ownerId) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Friend request not found",
      });
    }

    const nextStatus =
      args.action === "accept"
        ? "accepted"
        : args.action === "decline"
          ? "declined"
          : "blocked";
    await ctx.db.patch(relationship._id, {
      status: nextStatus,
      updatedAt: Date.now(),
      respondedAt: Date.now(),
    });
    const updated = await ctx.db.get(relationship._id);
    if (!updated) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to update friend request",
      });
    }
    return updated;
  },
});

export const removeFriend = mutation({
  args: {
    otherOwnerId: v.string(),
  },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "social_remove_friend",
      ownerId,
      RATE_STANDARD,
      "Too many requests. Please slow down and try again.",
    );
    const relationship = await loadRelationship(ctx, ownerId, args.otherOwnerId);
    if (!relationship) {
      return { removed: false };
    }
    ensureRelationshipIsAccepted(relationship);
    await ctx.db.delete(relationship._id);
    return { removed: true };
  },
});
