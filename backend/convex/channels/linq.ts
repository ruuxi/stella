import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { processIncomingMessage, processLinkCode } from "./utils";
import { retryFetch } from "../lib/retry_fetch";

// ---------------------------------------------------------------------------
// Linq API Helpers
// ---------------------------------------------------------------------------

const LINQ_API_BASE = "https://api.linqapp.com/api/partner";

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

const linqCreateChat = async (
  from: string,
  to: string[],
): Promise<string> => {
  const res = await linqFetch("/v3/chats", {
    method: "POST",
    body: JSON.stringify({ from, to }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Linq createChat failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { id?: string; chat_id?: string };
  const chatId = data.id ?? data.chat_id;
  if (!chatId) throw new Error("Linq createChat returned no chat ID");
  return chatId;
};

const linqSendMessage = async (
  chatId: string,
  text: string,
): Promise<void> => {
  const res = await linqFetch(`/v3/chats/${chatId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      parts: [{ type: "text", value: text }],
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
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("linq_chats")
      .withIndex("by_phone", (q) => q.eq("phoneNumber", args.phoneNumber))
      .first();
    return row?.linqChatId ?? null;
  },
});

export const cacheChatId = internalMutation({
  args: {
    phoneNumber: v.string(),
    linqChatId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("linq_chats")
      .withIndex("by_phone", (q) => q.eq("phoneNumber", args.phoneNumber))
      .first();

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
  ctx: { runQuery: Function; runMutation: Function },
  phoneNumber: string,
  text: string,
  incomingChatId?: string,
): Promise<void> => {
  const fromNumber = process.env.LINQ_FROM_NUMBER;
  if (!fromNumber) {
    console.error("[linq] Missing LINQ_FROM_NUMBER");
    return;
  }

  // Try incoming chat ID first (most reliable — same conversation thread)
  if (incomingChatId) {
    try {
      await linqSendMessage(incomingChatId, text);
      // Cache it for future use
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
      await linqSendMessage(cachedChatId, text);
      return;
    } catch (error) {
      console.error("[linq] Cached chatId stale, creating new:", error);
    }
  }

  // Create new chat
  const newChatId = await linqCreateChat(fromNumber, [phoneNumber]);
  await ctx.runMutation(internal.channels.linq.cacheChatId, {
    phoneNumber,
    linqChatId: newChatId,
  });
  await linqSendMessage(newChatId, text);
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
  returns: v.null(),
  handler: async (ctx, args) => {
    // Extract 6-digit code from text like "link ABC123" or just "ABC123"
    const codeMatch = args.text.match(/\b([A-Z0-9]{6})\b/i);
    const code = codeMatch?.[1]?.toUpperCase();

    if (!code) {
      await sendLinqReply(
        ctx,
        args.senderPhone,
        "Welcome to Stella! To link your account:\n\n" +
          "1. Open Stella desktop app\n" +
          "2. Go to Settings \u2192 Link Linq\n" +
          "3. Copy the 6-digit code\n" +
          "4. Text it here: link CODE",
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

    if (result === "invalid_code") {
      await sendLinqReply(
        ctx,
        args.senderPhone,
        "Invalid or expired code. Please generate a new one in Stella Settings.",
        args.incomingChatId,
      );
    } else if (result === "already_linked") {
      await sendLinqReply(
        ctx,
        args.senderPhone,
        "Your number is already linked to Stella!",
        args.incomingChatId,
      );
    } else if (result === "linking_disabled") {
      await sendLinqReply(
        ctx,
        args.senderPhone,
        "Linq linking is currently disabled.",
        args.incomingChatId,
      );
    } else if (result === "not_allowed") {
      await sendLinqReply(
        ctx,
        args.senderPhone,
        "This number is not allowed to link.",
        args.incomingChatId,
      );
    } else {
      await sendLinqReply(
        ctx,
        args.senderPhone,
        "Linked! You can now message Stella directly here via iMessage/SMS.",
        args.incomingChatId,
      );
    }
    return null;
  },
});

export const handleIncomingMessage = internalAction({
  args: {
    senderPhone: v.string(),
    text: v.string(),
    displayName: v.optional(v.string()),
    incomingChatId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const result = await processIncomingMessage({
        ctx,
        provider: "linq",
        externalUserId: args.senderPhone,
        text: args.text,
      });

      if (!result) {
        await sendLinqReply(
          ctx,
          args.senderPhone,
          "Your number isn't linked yet. Text \"link\" followed by your 6-digit code to get started.",
          args.incomingChatId,
        );
        return null;
      }

      await sendLinqReply(ctx, args.senderPhone, result.text, args.incomingChatId);
    } catch (error) {
      console.error("[linq] Agent turn failed:", error);
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

