import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { processIncomingMessage, processLinkCode } from "./channel_utils";

// ---------------------------------------------------------------------------
// Telegram API Helpers
// ---------------------------------------------------------------------------

const sendTelegramMessage = async (chatId: string, text: string) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("[telegram] Missing TELEGRAM_BOT_TOKEN");
    return;
  }

  // Escape special characters for MarkdownV2
  const escaped = text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");

  // Split into chunks of 4096 chars (Telegram limit)
  const maxLen = 4096;
  const chunks: string[] = [];
  for (let i = 0; i < escaped.length; i += maxLen) {
    chunks.push(escaped.slice(i, i + maxLen));
  }

  for (const chunk of chunks) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: "MarkdownV2",
        }),
      });
    } catch (error) {
      // If MarkdownV2 fails, retry without formatting
      console.error("[telegram] MarkdownV2 send failed, retrying plain:", error);
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.slice(0, maxLen),
        }),
      });
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
      return;
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
    } else {
      await sendTelegramMessage(
        args.chatId,
        "Linked! You can now message Stella directly here.",
      );
    }
  },
});

export const handleIncomingMessage = internalAction({
  args: {
    chatId: v.string(),
    telegramUserId: v.string(),
    text: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const result = await processIncomingMessage({
        ctx,
        provider: "telegram",
        externalUserId: args.telegramUserId,
        text: args.text,
      });

      if (!result) {
        await sendTelegramMessage(
          args.chatId,
          "Your account isn't linked yet. Send /start to get started.",
        );
        return;
      }

      await sendTelegramMessage(args.chatId, result.text);
    } catch (error) {
      console.error("[telegram] Agent turn failed:", error);
      await sendTelegramMessage(
        args.chatId,
        "Sorry, something went wrong. Please try again.",
      );
    }
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
          allowed_updates: ["message"],
        }),
      },
    );

    const result = await response.json();
    console.log("[telegram] Webhook registered:", result);
    return result;
  },
});
