import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { runAgentTurn } from "./automation/runner";
import { requireUserId } from "./auth";

// ---------------------------------------------------------------------------
// Ed25519 Signature Verification (Discord Interactions Endpoint)
// ---------------------------------------------------------------------------

const hexToUint8Array = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
};

export async function verifyDiscordSignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  publicKey: string,
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const message = encoder.encode(timestamp + rawBody);
    const sigBytes = hexToUint8Array(signature);
    const keyBytes = hexToUint8Array(publicKey);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes.buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );

    return await crypto.subtle.verify(
      "Ed25519",
      cryptoKey,
      sigBytes.buffer as ArrayBuffer,
      message.buffer as ArrayBuffer,
    );
  } catch (error) {
    console.error("[discord] Signature verification failed:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discord REST API Helpers
// ---------------------------------------------------------------------------

const DISCORD_API = "https://discord.com/api/v10";

const discordApi = async (
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> => {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("Missing DISCORD_BOT_TOKEN");

  return await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
};

/**
 * Edit the deferred interaction response (the "thinking..." message).
 * Must be called within 15 minutes of the original interaction.
 */
const editInteractionResponse = async (
  applicationId: string,
  interactionToken: string,
  content: string,
) => {
  // Discord message limit is 2000 chars
  const maxLen = 2000;
  const truncated =
    content.length > maxLen
      ? content.slice(0, maxLen - 20) + "\n\n... (truncated)"
      : content;

  const res = await fetch(
    `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: truncated }),
    },
  );

  if (!res.ok) {
    console.error(
      "[discord] Failed to edit interaction response:",
      res.status,
      await res.text(),
    );
  }
};

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
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_owner_default", (q) =>
        q.eq("ownerId", args.ownerId).eq("isDefault", true),
      )
      .first();

    if (existing) return existing._id;

    const now = Date.now();
    return await ctx.db.insert("conversations", {
      ownerId: args.ownerId,
      title: args.title ?? "Discord",
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

// Link code storage — same pattern as Telegram, using user_preferences
export const storeLinkCode = internalMutation({
  args: {
    ownerId: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const key = "discord_link_code";
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
    const prefs = await ctx.db
      .query("user_preferences")
      .filter((q) => q.eq(q.field("key"), "discord_link_code"))
      .collect();

    for (const pref of prefs) {
      try {
        const parsed = JSON.parse(pref.value) as { code: string; expiresAt: number };
        if (parsed.code === args.code && parsed.expiresAt > Date.now()) {
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
// Internal Actions (scheduled from webhook)
// ---------------------------------------------------------------------------

export const handleLinkCommand = internalAction({
  args: {
    applicationId: v.string(),
    interactionToken: v.string(),
    discordUserId: v.string(),
    codeArg: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Validate the link code
    const ownerId = await ctx.runMutation(internal.discord.consumeLinkCode, {
      code: args.codeArg,
    });

    if (!ownerId) {
      await editInteractionResponse(
        args.applicationId,
        args.interactionToken,
        "Invalid or expired code. Please generate a new one in Stella Settings.",
      );
      return;
    }

    // Check if already linked
    const existing = await ctx.runQuery(internal.discord.getConnectionByExternalId, {
      provider: "discord",
      externalUserId: args.discordUserId,
    });

    if (existing) {
      await editInteractionResponse(
        args.applicationId,
        args.interactionToken,
        "Your Discord account is already linked to Stella!",
      );
      return;
    }

    // Create the connection
    await ctx.runMutation(internal.discord.createConnection, {
      ownerId,
      provider: "discord",
      externalUserId: args.discordUserId,
      displayName: args.displayName,
    });

    await editInteractionResponse(
      args.applicationId,
      args.interactionToken,
      "Linked! You can now use `/ask` to message Stella.",
    );
  },
});

export const handleAskCommand = internalAction({
  args: {
    applicationId: v.string(),
    interactionToken: v.string(),
    discordUserId: v.string(),
    text: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Look up the connection
    const connection = await ctx.runQuery(internal.discord.getConnectionByExternalId, {
      provider: "discord",
      externalUserId: args.discordUserId,
    });

    if (!connection) {
      await editInteractionResponse(
        args.applicationId,
        args.interactionToken,
        "Your account isn't linked yet. Use `/link` with your 6-digit code from Stella Settings.",
      );
      return;
    }

    // Resolve or create conversation
    let conversationId = connection.conversationId;
    if (!conversationId) {
      conversationId = await ctx.runMutation(
        internal.discord.getOrCreateConversationForOwner,
        {
          ownerId: connection.ownerId,
          title: "Discord",
        },
      );
      await ctx.runMutation(internal.discord.setConnectionConversation, {
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
      await ctx.runMutation(internal.cloud_devices.touchActivity, {
        ownerId: connection.ownerId,
      });
    }

    // Run the agent turn
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

      const responseText = result.text.trim() || "(Stella had nothing to say.)";
      await editInteractionResponse(
        args.applicationId,
        args.interactionToken,
        responseText,
      );
    } catch (error) {
      console.error("[discord] Agent turn failed:", error);
      await editInteractionResponse(
        args.applicationId,
        args.interactionToken,
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

    await ctx.runMutation(internal.discord.storeLinkCode, {
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
        q.eq("ownerId", ownerId).eq("provider", "discord"),
      )
      .first();
  },
});

// ---------------------------------------------------------------------------
// One-time Setup: Register Slash Commands
// ---------------------------------------------------------------------------

export const registerCommands = internalAction({
  args: {},
  handler: async () => {
    const applicationId = process.env.DISCORD_APPLICATION_ID;
    if (!applicationId) {
      throw new Error("Missing DISCORD_APPLICATION_ID");
    }

    const commands = [
      {
        name: "ask",
        description: "Send a message to Stella",
        type: 1, // CHAT_INPUT
        options: [
          {
            name: "message",
            description: "Your message to Stella",
            type: 3, // STRING
            required: true,
          },
        ],
        // Enable in DMs and private channels for user-installed apps
        integration_types: [1], // USER_INSTALL
        contexts: [1, 2], // BOT_DM, PRIVATE_CHANNEL
      },
      {
        name: "link",
        description: "Link your Discord account to Stella with a 6-digit code",
        type: 1,
        options: [
          {
            name: "code",
            description: "The 6-digit code from Stella Settings",
            type: 3,
            required: true,
          },
        ],
        integration_types: [1],
        contexts: [1, 2],
      },
      {
        name: "status",
        description: "Check your Stella connection status",
        type: 1,
        integration_types: [1],
        contexts: [1, 2],
      },
    ];

    const res = await discordApi(
      `/applications/${applicationId}/commands`,
      "PUT",
      commands,
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to register commands: ${res.status} ${text}`);
    }

    const result = await res.json();
    console.log("[discord] Commands registered:", result);
    return result;
  },
});
