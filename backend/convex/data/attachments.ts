import { action, internalMutation, internalQuery } from "../_generated/server";
import { v, ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireConversationOwnerAction } from "../auth";

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
  handler: async (ctx, args): Promise<{
    _id: Id<"attachments">;
    storageKey: Id<"_storage">;
    url: string | null;
    mimeType: string;
    size: number;
  }> => {
    await requireConversationOwnerAction(ctx, args.conversationId);
    const { mimeType, bytes } = parseDataUrl(args.dataUrl);
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
    storageKey: v.string(),
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
