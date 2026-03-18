import {
  mutation,
  query,
} from "../_generated/server";
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
  requireConnectedUserId,
} from "../auth";

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
    const ownerId = await requireConnectedUserId(ctx);
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
    const ownerId = await requireConnectedUserId(ctx);
    const [incoming, outgoing] = await Promise.all([
      ctx.db
        .query("social_relationships")
        .withIndex("by_addresseeOwnerId_and_status", (q) =>
          q.eq("addresseeOwnerId", ownerId).eq("status", "pending"),
        )
        .collect(),
      ctx.db
        .query("social_relationships")
        .withIndex("by_requesterOwnerId_and_status", (q) =>
          q.eq("requesterOwnerId", ownerId).eq("status", "pending"),
        )
        .collect(),
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

export const sendFriendRequest = mutation({
  args: {
    friendCode: v.string(),
  },
  returns: socialRelationshipValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
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
    if (targetProfile.ownerId === ownerId) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "You cannot friend yourself",
      });
    }

    const existing = await loadRelationship(ctx, ownerId, targetProfile.ownerId);
    if (existing) {
      if (existing.status === "accepted") {
        return existing;
      }
      if (existing.status === "pending") {
        return existing;
      }
      await ctx.db.patch(existing._id, {
        requesterOwnerId: ownerId,
        addresseeOwnerId: targetProfile.ownerId,
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
    const id = await ctx.db.insert("social_relationships", {
      relationshipKey: getRelationshipKey(ownerId, targetProfile.ownerId),
      lowOwnerId: [ownerId, targetProfile.ownerId].sort((a, b) => a.localeCompare(b))[0]!,
      highOwnerId: [ownerId, targetProfile.ownerId].sort((a, b) => a.localeCompare(b))[1]!,
      requesterOwnerId: ownerId,
      addresseeOwnerId: targetProfile.ownerId,
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
    const relationship = await loadRelationship(ctx, ownerId, args.otherOwnerId);
    if (!relationship) {
      return { removed: false };
    }
    ensureRelationshipIsAccepted(relationship);
    await ctx.db.delete(relationship._id);
    return { removed: true };
  },
});
