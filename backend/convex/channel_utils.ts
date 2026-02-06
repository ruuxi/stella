import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import { runAgentTurn } from "./automation/runner";
import { requireUserId } from "./auth";

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

export const getConnectionByProviderAndExternalId = internalQuery({
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
      title: args.title ?? "Chat",
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

export const storeLinkCode = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const key = `${args.provider}_link_code`;
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
    provider: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const key = `${args.provider}_link_code`;
    const prefs = await ctx.db
      .query("user_preferences")
      .filter((q) => q.eq(q.field("key"), key))
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
// Public Queries/Mutations (for frontend)
// ---------------------------------------------------------------------------

export const generateLinkCode = mutation({
  args: { provider: v.string() },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();

    await ctx.runMutation(internal.channel_utils.storeLinkCode, {
      ownerId,
      provider: args.provider,
      code,
    });

    return { code };
  },
});

export const getConnection = query({
  args: { provider: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const ownerId = identity.subject;

    return await ctx.db
      .query("channel_connections")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", args.provider),
      )
      .first();
  },
});

export const deleteConnection = mutation({
  args: { provider: v.string() },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const conn = await ctx.db
      .query("channel_connections")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", args.provider),
      )
      .first();
    if (conn) await ctx.db.delete(conn._id);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Shared Helper Functions (called from provider action handlers)
// ---------------------------------------------------------------------------

/**
 * Common message handling: lookup connection → resolve conversation →
 * append event → resolve cloud device → run agent turn → return response.
 */
export async function processIncomingMessage(args: {
  ctx: ActionCtx;
  provider: string;
  externalUserId: string;
  text: string;
}): Promise<{ text: string } | null> {
  const connection = await args.ctx.runQuery(
    internal.channel_utils.getConnectionByProviderAndExternalId,
    { provider: args.provider, externalUserId: args.externalUserId },
  );
  if (!connection) return null;

  let conversationId = connection.conversationId;
  if (!conversationId) {
    conversationId = await args.ctx.runMutation(
      internal.channel_utils.getOrCreateConversationForOwner,
      { ownerId: connection.ownerId, title: args.provider },
    );
    await args.ctx.runMutation(internal.channel_utils.setConnectionConversation, {
      connectionId: connection._id,
      conversationId,
    });
  }

  await args.ctx.runMutation(internal.events.appendInternalEvent, {
    conversationId,
    type: "user_message",
    payload: { text: args.text },
  });

  const spriteName = await args.ctx.runQuery(
    internal.cloud_devices.resolveForOwner,
    { ownerId: connection.ownerId },
  );

  if (spriteName) {
    await args.ctx.runMutation(internal.cloud_devices.touchActivity, {
      ownerId: connection.ownerId,
    });
  }

  const result = await runAgentTurn({
    ctx: args.ctx,
    conversationId,
    prompt: args.text,
    agentType: "orchestrator",
    ownerId: connection.ownerId,
    targetDeviceId: undefined,
    spriteName: spriteName ?? undefined,
  });

  return { text: result.text.trim() || "(Stella had nothing to say.)" };
}

/**
 * Common link code validation: consume code → check existing →
 * create connection → return status.
 */
export async function processLinkCode(args: {
  ctx: ActionCtx;
  provider: string;
  externalUserId: string;
  code: string;
  displayName?: string;
}): Promise<"linked" | "already_linked" | "invalid_code"> {
  const ownerId = await args.ctx.runMutation(
    internal.channel_utils.consumeLinkCode,
    { provider: args.provider, code: args.code },
  );
  if (!ownerId) return "invalid_code";

  const existing = await args.ctx.runQuery(
    internal.channel_utils.getConnectionByProviderAndExternalId,
    { provider: args.provider, externalUserId: args.externalUserId },
  );
  if (existing) return "already_linked";

  await args.ctx.runMutation(internal.channel_utils.createConnection, {
    ownerId,
    provider: args.provider,
    externalUserId: args.externalUserId,
    displayName: args.displayName,
  });
  return "linked";
}
