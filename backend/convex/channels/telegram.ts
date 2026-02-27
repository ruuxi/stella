import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { processIncomingMessage, processLinkCode } from "./utils";
import { retryFetch } from "../lib/retry_fetch";
import { channelAttachmentValidator, optionalChannelEnvelopeValidator } from "../shared_validators";

// ---------------------------------------------------------------------------
// Telegram API Helpers
// ---------------------------------------------------------------------------

const TELEGRAM_MAX_LEN = 4096;

const escapeMarkdownV2 = (value: string) =>
  value.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");

const sendTelegramChunk = async (
  token: string,
  chatId: string,
  text: string,
  parseMode?: "MarkdownV2",
) => {
  const body: { chat_id: string; text: string; parse_mode?: "MarkdownV2" } = {
    chat_id: chatId,
    text,
  };
  if (parseMode) body.parse_mode = parseMode;

  const res = await retryFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null) as
    | { ok?: boolean; description?: string }
    | null;

  if (!res.ok || data?.ok === false) {
    const description =
      data?.description ??
      `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
    throw new Error(description);
  }
};

const sendTelegramMessage = async (chatId: string, text: string) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("[telegram] Missing TELEGRAM_BOT_TOKEN");
    return;
  }

  // Split original text into Telegram-size chunks.
  const rawChunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MAX_LEN) {
    rawChunks.push(text.slice(i, i + TELEGRAM_MAX_LEN));
  }

  for (const rawChunk of rawChunks) {
    const escapedChunk = escapeMarkdownV2(rawChunk);
    let sent = false;

    // Try MarkdownV2 first when escaping fits in Telegram's limit.
    if (escapedChunk.length <= TELEGRAM_MAX_LEN) {
      try {
        await sendTelegramChunk(token, chatId, escapedChunk, "MarkdownV2");
        sent = true;
      } catch (error) {
        console.error("[telegram] MarkdownV2 send failed, retrying plain:", error);
      }
    }

    if (!sent) {
      try {
        await sendTelegramChunk(token, chatId, rawChunk);
      } catch (error) {
        console.error("[telegram] Plain send failed:", error);
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Internal Actions (scheduled from webhook)
// ---------------------------------------------------------------------------

export const handleStartCommand = internalAction({
  args: {
    chatId: v.string(),
    telegramUserId: v.string(),
    codeArg: v.optional(v.string()),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.codeArg) {
      await sendTelegramMessage(
        args.chatId,
        "Welcome to Stella! To link your account:\n\n" +
          "1. Open Stella desktop app\n" +
          "2. Go to Settings → Link Telegram\n" +
          "3. Copy the 6-digit code\n" +
          "4. Send it here: /start CODE",
      );
      return null;
    }

    const result = await processLinkCode({
      ctx,
      provider: "telegram",
      externalUserId: args.telegramUserId,
      code: args.codeArg,
      displayName: args.displayName,
    });

    if (result === "invalid_code") {
      await sendTelegramMessage(
        args.chatId,
        "Invalid or expired code. Please generate a new one in Stella Settings.",
      );
    } else if (result === "already_linked") {
      await sendTelegramMessage(args.chatId, "Your Telegram is already linked to Stella!");
    } else if (result === "linking_disabled") {
      await sendTelegramMessage(
        args.chatId,
        "Telegram linking is disabled while Private Local mode is on. Enable Connected mode in Stella Settings.",
      );
    } else if (result === "not_allowed") {
      await sendTelegramMessage(args.chatId, "This Telegram account is not allowed to link.");
    } else {
      await sendTelegramMessage(
        args.chatId,
        "Linked! You can now message Stella directly here.",
      );
    }
    return null;
  },
});

export const handleIncomingMessage = internalAction({
  args: {
    chatId: v.string(),
    telegramUserId: v.string(),
    text: v.string(),
    displayName: v.optional(v.string()),
    groupId: v.optional(v.string()),
    attachments: v.optional(v.array(channelAttachmentValidator)),
    channelEnvelope: optionalChannelEnvelopeValidator,
    respond: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const shouldRespond = args.respond !== false;

    try {
      const result = await processIncomingMessage({
        ctx,
        provider: "telegram",
        externalUserId: args.telegramUserId,
        text: args.text,
        groupId: args.groupId,
        attachments: args.attachments,
        channelEnvelope: args.channelEnvelope,
        respond: args.respond,
      });

      if (!result) {
        if (!shouldRespond) return null;
        await sendTelegramMessage(
          args.chatId,
          "Your account isn't linked yet. Send /start to get started.",
        );
        return null;
      }

      if (shouldRespond) {
        await sendTelegramMessage(args.chatId, result.text);
      }
    } catch (error) {
      console.error("[telegram] Agent turn failed:", error);
      if (shouldRespond) {
        await sendTelegramMessage(
          args.chatId,
          "Sorry, something went wrong. Please try again.",
        );
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// One-time Setup
// ---------------------------------------------------------------------------

export const registerWebhook = internalAction({
  args: {},
  handler: async () => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const siteUrl = process.env.CONVEX_SITE_URL;

    if (!token || !secret || !siteUrl) {
      throw new Error("Missing TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, or CONVEX_SITE_URL");
    }

    const webhookUrl = `${siteUrl}/api/webhooks/telegram`;

    const response = await fetch(
      `https://api.telegram.org/bot${token}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: secret,
          allowed_updates: [
            "message",
            "edited_message",
            "message_reaction",
            "message_reaction_count",
          ],
        }),
      },
    );

    const result = await response.json().catch(() => null) as
      | { ok?: boolean; description?: string }
      | null;
    const normalized = {
      ok: Boolean(result?.ok ?? response.ok),
      description: typeof result?.description === "string" ? result.description : undefined,
    };
    console.log("[telegram] Webhook registered:", normalized);
    return normalized;
  },
});
