import {
  mutation,
  query,
} from "../_generated/server";
import { ConvexError, v } from "convex/values";
import {
  socialMessageValidator,
  requireRoomMembership,
  refreshRoomUpdatedAt,
} from "./shared";
import {
  clampPageLimit,
  requireBoundedString,
} from "../shared_validators";
import {
  requireConnectedUserId,
} from "../auth";
import {
  enforceMutationRateLimit,
  RATE_STANDARD,
} from "../lib/rate_limits";

export const listRoomMessages = query({
  args: {
    roomId: v.id("social_rooms"),
    limit: v.optional(v.number()),
    beforeCreatedAt: v.optional(v.number()),
  },
  returns: v.array(socialMessageValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await requireRoomMembership(ctx, args.roomId, ownerId);
    const limit = clampPageLimit(args.limit, 100, 500);
    const query = ctx.db
      .query("social_messages")
      .withIndex("by_roomId_and_createdAt", (q) =>
        args.beforeCreatedAt !== undefined
          ? q.eq("roomId", args.roomId).lt("createdAt", args.beforeCreatedAt)
          : q.eq("roomId", args.roomId),
      )
      .order("desc");
    const messages = await query.take(limit);
    return messages.reverse();
  },
});

export const sendRoomMessage = mutation({
  args: {
    roomId: v.id("social_rooms"),
    body: v.string(),
    clientMessageId: v.optional(v.string()),
  },
  returns: socialMessageValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    // Standard chat rate: enough for normal typing, low enough that a
    // misbehaving client can't firehose a shared room.
    await enforceMutationRateLimit(
      ctx,
      "social_send_room_message",
      ownerId,
      RATE_STANDARD,
      "You're sending messages too fast. Please slow down.",
    );
    const membership = await requireRoomMembership(ctx, args.roomId, ownerId);

    const body = args.body.trim();
    if (!body) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Message body is required",
      });
    }
    requireBoundedString(body, "body", 20_000);

    const clientMessageId = args.clientMessageId?.trim();
    if (clientMessageId) {
      requireBoundedString(clientMessageId, "clientMessageId", 128);
      const existing = await ctx.db
        .query("social_messages")
        .withIndex("by_roomId_and_clientMessageId", (q) =>
          q.eq("roomId", args.roomId).eq("clientMessageId", clientMessageId),
        )
        .unique();
      if (existing) {
        return existing;
      }
    }

    const now = Date.now();
    const id = await ctx.db.insert("social_messages", {
      roomId: args.roomId,
      senderOwnerId: ownerId,
      clientMessageId,
      kind: "text",
      body,
      createdAt: now,
    });
    await ctx.db.patch(membership._id, {
      lastReadMessageId: id,
      lastReadAt: now,
      updatedAt: now,
    });
    await refreshRoomUpdatedAt(ctx, args.roomId, now);
    const created = await ctx.db.get(id);
    if (!created) {
      throw new ConvexError({
        code: "INTERNAL_ERROR",
        message: "Failed to create message",
      });
    }
    return created;
  },
});
