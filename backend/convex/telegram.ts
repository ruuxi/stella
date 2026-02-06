import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { runAgentTurn } from "./automation/runner";
import { requireUserId } from "./auth";

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

export const getConnectionByExternalId = internalQuery({
  args: {
    provider: v.string(),
    externalUserId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("channel_connections")
      .withIndex("by_provider_external", (q) =>
        q.eq("provider", args.provider).eq("externalUserId", args.externalUserId),
      )
      .first();
  },
});

// ---------------------------------------------------------------------------
// Internal Mutations
// ---------------------------------------------------------------------------

export const createConnection = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    externalUserId: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("channel_connections", {
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
      displayName: args.displayName,
      linkedAt: now,
      updatedAt: now,
    });
  },
});

export const getOrCreateConversationForOwner = internalMutation({
  args: {
    ownerId: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Try to find an existing default conversation for this owner
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_owner_default", (q) =>
        q.eq("ownerId", args.ownerId).eq("isDefault", true),
      )
      .first();

    if (existing) return existing._id;

    // Create a new default conversation
    const now = Date.now();
    return await ctx.db.insert("conversations", {
      ownerId: args.ownerId,
      title: args.title ?? "Telegram",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const setConnectionConversation = internalMutation({
  args: {
    connectionId: v.id("channel_connections"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.connectionId, {
      conversationId: args.conversationId,
      updatedAt: Date.now(),
    });
  },
});

// Link code storage via user_preferences
export const storeLinkCode = internalMutation({
  args: {
    ownerId: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const key = "telegram_link_code";
    const now = Date.now();
    const value = JSON.stringify({ code: args.code, expiresAt: now + 5 * 60 * 1000 });

    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", args.ownerId).eq("key", key))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt: now });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId: args.ownerId,
        key,
        value,
        updatedAt: now,
      });
    }
  },
});

export const consumeLinkCode = internalMutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    // Scan all telegram_link_code preferences to find the matching code
    const prefs = await ctx.db
      .query("user_preferences")
      .filter((q) => q.eq(q.field("key"), "telegram_link_code"))
      .collect();

    for (const pref of prefs) {
      try {
        const parsed = JSON.parse(pref.value) as { code: string; expiresAt: number };
        if (parsed.code === args.code && parsed.expiresAt > Date.now()) {
          // Found a valid code — delete it and return the ownerId
          await ctx.db.delete(pref._id);
          return pref.ownerId;
        }
      } catch {
        // Skip malformed entries
      }
    }
    return null;
  },
});

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

    // Validate the link code
    const ownerId = await ctx.runMutation(internal.telegram.consumeLinkCode, {
      code: args.codeArg,
    });

    if (!ownerId) {
      await sendTelegramMessage(
        args.chatId,
        "Invalid or expired code. Please generate a new one in Stella Settings.",
      );
      return;
    }

    // Check if already linked
    const existing = await ctx.runQuery(internal.telegram.getConnectionByExternalId, {
      provider: "telegram",
      externalUserId: args.telegramUserId,
    });

    if (existing) {
      await sendTelegramMessage(args.chatId, "Your Telegram is already linked to Stella!");
      return;
    }

    // Create the connection
    await ctx.runMutation(internal.telegram.createConnection, {
      ownerId,
      provider: "telegram",
      externalUserId: args.telegramUserId,
      displayName: args.displayName,
    });

    await sendTelegramMessage(
      args.chatId,
      "Linked! You can now message Stella directly here.",
    );
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
    // Look up the connection
    const connection = await ctx.runQuery(internal.telegram.getConnectionByExternalId, {
      provider: "telegram",
      externalUserId: args.telegramUserId,
    });

    if (!connection) {
      await sendTelegramMessage(
        args.chatId,
        "Your account isn't linked yet. Send /start to get started.",
      );
      return;
    }

    // Resolve or create conversation
    let conversationId = connection.conversationId;
    if (!conversationId) {
      conversationId = await ctx.runMutation(
        internal.telegram.getOrCreateConversationForOwner,
        {
          ownerId: connection.ownerId,
          title: "Telegram",
        },
      );
      // Save the conversation on the connection for future messages
      await ctx.runMutation(internal.telegram.setConnectionConversation, {
        connectionId: connection._id,
        conversationId,
      });
    }

    // Insert the user message as an event
    await ctx.runMutation(internal.events.appendInternalEvent, {
      conversationId,
      type: "user_message",
      payload: { text: args.text },
    });

    // Resolve cloud device if 24/7 mode is enabled
    const spriteName = await ctx.runQuery(internal.cloud_devices.resolveForOwner, {
      ownerId: connection.ownerId,
    });

    if (spriteName) {
      // Touch activity to track cloud device usage
      await ctx.runMutation(internal.cloud_devices.touchActivity, {
        ownerId: connection.ownerId,
      });
    }

    // Run the agent turn (cloud tools if sprite available, backend-only otherwise)
    try {
      const result = await runAgentTurn({
        ctx,
        conversationId,
        prompt: args.text,
        agentType: "orchestrator",
        ownerId: connection.ownerId,
        targetDeviceId: undefined,
        spriteName: spriteName ?? undefined,
      });

      if (result.text.trim()) {
        await sendTelegramMessage(args.chatId, result.text);
      } else {
        await sendTelegramMessage(args.chatId, "(Stella had nothing to say.)");
      }
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
// Public Mutations (for frontend)
// ---------------------------------------------------------------------------

export const generateLinkCode = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();

    await ctx.runMutation(internal.telegram.storeLinkCode, {
      ownerId,
      code,
    });

    return { code };
  },
});

export const getConnection = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const ownerId = identity.subject;

    return await ctx.db
      .query("channel_connections")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", "telegram"),
      )
      .first();
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
