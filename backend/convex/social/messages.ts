import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
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
  getConnectedUserIdOrNull,
  requireConnectedUserId,
} from "../auth";
import {
  enforceMutationRateLimit,
  RATE_STANDARD,
} from "../lib/rate_limits";
import {
  assistantText,
  completeManagedChat,
} from "../runtime_ai/managed";
import { getModeConfig } from "../agent/model";
import { maskBannedTerms } from "./censor";

const SOCIAL_MODERATION_SYSTEM_PROMPT = [
  "You are a social chat moderation classifier.",
  "Return exactly one token: YES or NO.",
  "",
  "YES means the message contains content that should be censored in a social chat: slurs, dehumanizing hate, harassment, explicit sexual content, sexual assault language, child sexual abuse references, or common bypass variants.",
  "NO means the message should remain visible as written.",
  "Catch evasion such as repeated letters, leetspeak, separators, zero-width characters, and Unicode lookalikes.",
].join("\n");

function parseModerationResponse(raw: string): "clean" | "censored" | null {
  const normalized = raw.trim().toUpperCase();
  if (normalized === "YES") return "censored";
  if (normalized === "NO") return "clean";
  const firstToken = normalized.split(/\s+/)[0];
  if (firstToken === "YES") return "censored";
  if (firstToken === "NO") return "clean";
  return null;
}

export const listRoomMessages = query({
  args: {
    roomId: v.id("social_rooms"),
    limit: v.optional(v.number()),
    beforeCreatedAt: v.optional(v.number()),
  },
  returns: v.array(socialMessageValidator),
  handler: async (ctx, args) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
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

export const getMessageForModerationInternal = internalQuery({
  args: {
    messageId: v.id("social_messages"),
  },
  returns: v.union(v.null(), socialMessageValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.messageId);
  },
});

export const applyMessageModerationInternal = internalMutation({
  args: {
    messageId: v.id("social_messages"),
    originalBody: v.string(),
    moderatedBody: v.optional(v.string()),
    status: v.union(
      v.literal("clean"),
      v.literal("censored"),
      v.literal("failed"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.kind !== "text") {
      return null;
    }
    if (message.moderationStatus !== "pending") {
      return null;
    }
    if (message.body !== args.originalBody) {
      return null;
    }

    const now = Date.now();
    if (args.status === "censored" && args.moderatedBody) {
      await ctx.db.patch(args.messageId, {
        body: args.moderatedBody,
        originalBody: args.originalBody,
        moderationStatus: "censored",
        moderatedAt: now,
      });
      return null;
    }

    await ctx.db.patch(args.messageId, {
      moderationStatus: args.status,
      moderatedAt: now,
    });
    return null;
  },
});

export const moderateRoomMessageInternal = internalAction({
  args: {
    messageId: v.id("social_messages"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.runQuery(
      internal.social.messages.getMessageForModerationInternal,
      { messageId: args.messageId },
    );
    if (!message || message.kind !== "text" || message.moderationStatus !== "pending") {
      return null;
    }

    try {
      const result = await completeManagedChat({
        config: getModeConfig("social_moderation"),
        fallbackConfig: {
          ...getModeConfig("standard"),
          temperature: 0.7,
          maxOutputTokens: 512,
        },
        context: {
          systemPrompt: SOCIAL_MODERATION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: message.body,
              timestamp: Date.now(),
            },
          ],
        },
      });
      const parsed = parseModerationResponse(assistantText(result));
      if (!parsed) {
        throw new Error("Moderation model returned an invalid decision");
      }
      await ctx.runMutation(internal.social.messages.applyMessageModerationInternal, {
        messageId: args.messageId,
        originalBody: message.body,
        moderatedBody: parsed === "censored" ? maskBannedTerms(message.body) : undefined,
        status: parsed,
      });
    } catch (error) {
      console.warn("[social-moderation] Failed to moderate message", error);
      await ctx.runMutation(internal.social.messages.applyMessageModerationInternal, {
        messageId: args.messageId,
        originalBody: message.body,
        status: "failed",
      });
    }
    return null;
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
      moderationStatus: "pending",
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.social.messages.moderateRoomMessageInternal, {
      messageId: id,
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
