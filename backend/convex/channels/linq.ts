import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v, ConvexError } from "convex/values";
import { processIncomingMessage } from "./message_pipeline";
import { processLinkCode } from "./link_codes";
import { SIGN_IN_REQUIRED_ERROR } from "./routing_flow";
import { retryFetch } from "../lib/retry_fetch";
import { channelAttachmentValidator, optionalChannelEnvelopeValidator } from "../shared_validators";

// ---------------------------------------------------------------------------
// Linq API Helpers
// ---------------------------------------------------------------------------

const LINQ_API_BASE = "https://api.linqapp.com/api/partner";
const PRIMARY_LINQ_CONVEX_URL = "https://benevolent-minnow-586.convex.cloud";
const LINQ_NON_PRIMARY_OVERRIDE_ENV = "LINQ_ALLOW_NON_PRIMARY_DEPLOYMENT";
type LinkCodeResult = Awaited<ReturnType<typeof processLinkCode>>;

const LINK_RESULT_MESSAGE: Record<LinkCodeResult, string> = {
  invalid_code: "Invalid or expired code. Please generate a new one in Stella Settings.",
  already_linked: "Your number is already linked to Stella!",
  linking_disabled:
    "Linq linking is disabled while Private Local mode is on. Enable Connected mode in Stella Settings.",
  not_allowed: "This number is not allowed to link.",
  linked: "Linked! You can now message Stella directly here via iMessage/SMS.",
};

const linqFetch = async (
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const token = process.env.LINQ_API_TOKEN;
  if (!token) throw new Error("Missing LINQ_API_TOKEN");

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");

  return retryFetch(`${LINQ_API_BASE}${path}`, {
    ...init,
    headers,
  });
};

export const isLinqLiveDeployment = (): boolean => {
  if (process.env[LINQ_NON_PRIMARY_OVERRIDE_ENV]?.trim() === "1") {
    return true;
  }
  return process.env.CONVEX_URL?.trim() === PRIMARY_LINQ_CONVEX_URL;
};

type LinqMessagePart =
  | { type: "text"; value: string }
  | { type: "media"; url: string };

const linqCreateChat = async (
  from: string,
  to: string[],
  text: string,
  extraParts?: LinqMessagePart[],
): Promise<string> => {
  const parts: LinqMessagePart[] = [{ type: "text", value: text }];
  if (extraParts) parts.push(...extraParts);
  const res = await linqFetch("/v3/chats", {
    method: "POST",
    body: JSON.stringify({
      from,
      to,
      message: { parts },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Linq createChat failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const chatId =
    (data.id as string | undefined) ??
    (data.chat_id as string | undefined) ??
    (data.chatId as string | undefined) ??
    ((data.data as Record<string, unknown> | undefined)?.id as string | undefined) ??
    ((data.data as Record<string, unknown> | undefined)?.chat_id as string | undefined);
  if (!chatId) {
    console.error("[linq] createChat response has no chat ID:", JSON.stringify(data));
    throw new Error(`Linq createChat returned no chat ID: ${JSON.stringify(data)}`);
  }
  return chatId;
};

const linqSendMessage = async (
  chatId: string,
  text: string,
  extraParts?: LinqMessagePart[],
): Promise<void> => {
  const parts: LinqMessagePart[] = [{ type: "text", value: text }];
  if (extraParts) parts.push(...extraParts);
  const res = await linqFetch(`/v3/chats/${chatId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      message: { parts },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Linq sendMessage failed: ${res.status} ${body}`);
  }
};

// ---------------------------------------------------------------------------
// HMAC Signature Verification
// ---------------------------------------------------------------------------

export async function verifyLinqSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  secret: string,
): Promise<boolean> {
  if (!signature || !timestamp || !secret) return false;

  // Replay protection: reject timestamps older than 5 minutes
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const message = `${timestamp}.${rawBody}`;
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Internal Queries / Mutations — Chat ID Cache
// ---------------------------------------------------------------------------

export const getCachedChatId = internalQuery({
  args: { phoneNumber: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("linq_chats")
      .withIndex("by_phoneNumber", (q) => q.eq("phoneNumber", args.phoneNumber))
      .unique();
    return row?.linqChatId ?? null;
  },
});

export const cacheChatId = internalMutation({
  args: {
    phoneNumber: v.string(),
    linqChatId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("linq_chats")
      .withIndex("by_phoneNumber", (q) => q.eq("phoneNumber", args.phoneNumber))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { linqChatId: args.linqChatId });
    } else {
      await ctx.db.insert("linq_chats", {
        phoneNumber: args.phoneNumber,
        linqChatId: args.linqChatId,
        createdAt: Date.now(),
      });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Send Reply Helper (get-or-create chat + send)
// ---------------------------------------------------------------------------

/**
 * Sends a reply to a phone number via Linq.
 * If `incomingChatId` is provided, tries that first.
 * Falls back to creating a new chat if needed.
 */
const sendLinqReply = async (
  ctx: ActionCtx,
  phoneNumber: string,
  text: string,
  incomingChatId?: string,
  extraParts?: LinqMessagePart[],
): Promise<void> => {
  if (!isLinqLiveDeployment()) {
    console.log(
      `[linq] Skipping outbound Linq send on non-primary deployment (${process.env.CONVEX_URL ?? "unknown"}).`,
    );
    return;
  }

  const fromNumber = process.env.LINQ_FROM_NUMBER;
  if (!fromNumber) {
    console.error("[linq] Missing LINQ_FROM_NUMBER — cannot send reply!");
    return;
  }

  // Try incoming chat ID first (most reliable — same conversation thread)
  if (incomingChatId) {
    try {
      await linqSendMessage(incomingChatId, text, extraParts);
      await ctx.runMutation(internal.channels.linq.cacheChatId, {
        phoneNumber,
        linqChatId: incomingChatId,
      });
      return;
    } catch (error) {
      console.error("[linq] Send via incomingChatId failed, trying cached/new:", error);
    }
  }

  // Try cached chat ID
  const cachedChatId = await ctx.runQuery(internal.channels.linq.getCachedChatId, {
    phoneNumber,
  });

  if (cachedChatId) {
    try {
      await linqSendMessage(cachedChatId, text, extraParts);
      return;
    } catch (error) {
      console.error("[linq] Cached chatId stale, creating new:", error);
    }
  }

  // Create new chat (sends initial message as part of creation)
  const newChatId = await linqCreateChat(fromNumber, [phoneNumber], text, extraParts);
  await ctx.runMutation(internal.channels.linq.cacheChatId, {
    phoneNumber,
    linqChatId: newChatId,
  });
};

// ---------------------------------------------------------------------------
// Internal Actions (scheduled from webhook)
// ---------------------------------------------------------------------------

export const handleStartCommand = internalAction({
  args: {
    senderPhone: v.string(),
    text: v.string(),
    incomingChatId: v.string(),
  },
  handler: async (ctx, args) => {
    // Extract 6-digit code from text like "link ABC123" or just "ABC123"
    const codeMatch = args.text.match(/\b([A-Z0-9]{6})\b/i);
    const code = codeMatch?.[1]?.toUpperCase();

    if (!code) {
      await sendLinqReply(
        ctx,
        args.senderPhone,
        "Welcome to Stella! To link your number:\n\n" +
          "1. Open Stella desktop app\n" +
          "2. Go to Settings \u2192 Text Stella\n" +
          "3. Copy the 6-digit code\n" +
          "4. Text it here",
        args.incomingChatId,
      );
      return null;
    }

    const result = await processLinkCode({
      ctx,
      provider: "linq",
      externalUserId: args.senderPhone,
      code,
    });

    await sendLinqReply(
      ctx,
      args.senderPhone,
      LINK_RESULT_MESSAGE[result],
      args.incomingChatId,
    );
    return null;
  },
});

export const handleIncomingMessage = internalAction({
  args: {
    senderPhone: v.string(),
    text: v.string(),
    incomingChatId: v.string(),
    groupId: v.optional(v.string()),
    attachments: v.optional(v.array(channelAttachmentValidator)),
    channelEnvelope: optionalChannelEnvelopeValidator,
    respond: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const shouldRespond = args.respond !== false;
    console.log(`[linq:trace] Incoming message from ${args.senderPhone}`);
    try {
      const result = await processIncomingMessage({
        ctx,
        provider: "linq",
        externalUserId: args.senderPhone,
        text: args.text,
        groupId: args.groupId,
        attachments: args.attachments,
        channelEnvelope: args.channelEnvelope,
        respond: args.respond,
        deliveryMeta: {
          senderPhone: args.senderPhone,
          incomingChatId: args.incomingChatId,
        },
      });

      console.log(`[linq:trace] processIncomingMessage result: deferred=${result?.deferred}, hasText=${!!result?.text}`);
      if (result?.deferred) return null;

      if (!result) {
        if (!shouldRespond) return null;
        await sendLinqReply(
          ctx,
          args.senderPhone,
          "Your number isn't linked yet. Open Stella \u2192 Settings \u2192 Text Stella, then text your 6-digit code here.",
          args.incomingChatId,
        );
        return null;
      }

      if (!shouldRespond) return null;
      await sendLinqReply(ctx, args.senderPhone, result.text, args.incomingChatId);
    } catch (error) {
      console.error("[linq] Agent turn failed:", error);
      if (!shouldRespond) return null;
      await sendLinqReply(
        ctx,
        args.senderPhone,
        "Sorry, something went wrong. Please try again.",
        args.incomingChatId,
      );
    }
    return null;
  },
});

export const sendWelcomeMessage = internalAction({
  args: { phoneNumber: v.string() },
  handler: async (ctx, args) => {
    await sendLinqReply(
      ctx,
      args.phoneNumber,
      "You\u2019re connected! Text me anytime and I\u2019ll respond right here. " +
        "I can also take actions on your computer while we chat.",
    );
    return null;
  },
});

// ---------------------------------------------------------------------------
// Public Action — Desktop initiates SMS to the user's phone
// ---------------------------------------------------------------------------

const E164_REGEX = /^\+[1-9]\d{6,14}$/;
const STELLA_VCARD_URL = "https://benevolent-minnow-586.convex.site/stella.vcf";

export const sendLinqLinkSms = action({
  args: { phoneNumber: v.string() },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    if (!isLinqLiveDeployment()) {
      throw new ConvexError(
        "Text Stella is only enabled on the primary Stella deployment.",
      );
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError(SIGN_IN_REQUIRED_ERROR);
    if ((identity as Record<string, unknown>).isAnonymous === true) {
      throw new ConvexError(SIGN_IN_REQUIRED_ERROR);
    }

    const phone = args.phoneNumber.replace(/[\s\-().]/g, "");
    if (!E164_REGEX.test(phone)) {
      throw new ConvexError("Please enter a valid phone number with country code (e.g. +1…).");
    }

    const fromNumber = process.env.LINQ_FROM_NUMBER;
    if (!fromNumber) throw new Error("Missing LINQ_FROM_NUMBER");

    const { code } = await ctx.runMutation(
      internal.channels.link_codes.generateAndStoreLinkCode,
      { ownerId: identity.subject, provider: "linq" },
    );

    const message =
      `Your Stella code is: ${code}\n\n` +
      `Enter this code on your desktop to connect.\n\n` +
      `Tap the contact card below to save Stella to your contacts.`;

    await sendLinqReply(ctx, phone, message, undefined, [
      { type: "media", url: STELLA_VCARD_URL },
    ]);

    return { success: true };
  },
});
