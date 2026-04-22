import { action, internalMutation, internalQuery } from "../_generated/server";
import { v, ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireConversationOwnerAction, requireUserId } from "../auth";
import {
  enforceActionRateLimit,
  RATE_EXPENSIVE,
} from "../lib/rate_limits";

const parseDataUrl = (dataUrl: string) => {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Invalid data URL" });
  }
  const [, mimeType, base64] = match;
  // Use atob + Uint8Array instead of Buffer (not available in Convex runtime)
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return { mimeType, bytes };
};

export const createFromDataUrl = action({
  args: {
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    dataUrl: v.string(),
  },
  returns: v.object({
    _id: v.id("attachments"),
    storageKey: v.id("_storage"),
    url: v.union(v.null(), v.string()),
    mimeType: v.string(),
    size: v.number(),
  }),
  handler: async (ctx, args): Promise<{
    _id: Id<"attachments">;
    storageKey: Id<"_storage">;
    url: string | null;
    mimeType: string;
    size: number;
  }> => {
    const ownerId = await requireUserId(ctx);
    await requireConversationOwnerAction(ctx, args.conversationId);

    // Each call decodes and stores up to 10 MB into _storage. Without this,
    // a misbehaving client (or compromised desktop) can fill the storage
    // bucket and inflate the user's bill in a very tight loop.
    await enforceActionRateLimit(
      ctx,
      "attachment_create_from_data_url",
      ownerId,
      RATE_EXPENSIVE,
      "Too many attachment uploads. Please wait a moment and try again.",
    );

    const { mimeType, bytes } = parseDataUrl(args.dataUrl);

    const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: `Attachment exceeds maximum allowed size of ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB`,
      });
    }

    const blob = new Blob([bytes], { type: mimeType });
    const storageId = await ctx.storage.store(blob);
    const url = await ctx.storage.getUrl(storageId);

    const attachmentId = await ctx.runMutation(
      internal.data.attachments.insertAttachment,
      {
        conversationId: args.conversationId,
        deviceId: args.deviceId,
        storageKey: storageId,
        url: url ?? undefined,
        mimeType,
        size: bytes.byteLength,
      },
    );

    return {
      _id: attachmentId,
      storageKey: storageId,
      url,
      mimeType,
      size: bytes.byteLength,
    };
  },
});

export const insertAttachment = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    storageKey: v.id("_storage"),
    url: v.optional(v.string()),
    mimeType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("attachments", {
      conversationId: args.conversationId,
      deviceId: args.deviceId,
      storageKey: args.storageKey,
      url: args.url,
      mimeType: args.mimeType,
      size: args.size,
      createdAt: Date.now(),
    });
  },
});

export const getById = internalQuery({
  args: { id: v.id("attachments") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});
