import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { components, internal } from "../_generated/api";
import { v } from "convex/values";
import { RateLimiter } from "@convex-dev/rate-limiter";
import type { ActionCtx } from "../_generated/server";
import { runAgentTurn } from "../automation/runner";
import { requireUserId } from "../auth";

type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

const DM_POLICY_DEFAULT: DmPolicy = "pairing";
const LINK_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const channelConnectionValidator = v.object({
  _id: v.id("channel_connections"),
  _creationTime: v.number(),
  ownerId: v.string(),
  provider: v.string(),
  externalUserId: v.string(),
  conversationId: v.optional(v.id("conversations")),
  displayName: v.optional(v.string()),
  linkedAt: v.number(),
  updatedAt: v.number(),
});

const getDmPolicyKey = (provider: string) => `${provider}_dm_policy`;
const getDmAllowlistKey = (provider: string) => `${provider}_dm_allowlist`;
const getDmDenylistKey = (provider: string) => `${provider}_dm_denylist`;

const normalizeDmPolicy = (value: string | null | undefined): DmPolicy => {
  if (
    value === "pairing" ||
    value === "allowlist" ||
    value === "open" ||
    value === "disabled"
  ) {
    return value;
  }
  return DM_POLICY_DEFAULT;
};

const parseStringList = (value: string | null | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const uniqueSorted = (values: string[]) => [...new Set(values)].sort();

const webhookRateLimiter = new RateLimiter(components.rateLimiter);

const generateSecureLinkCode = (length = 6): string => {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length]).join("");
  }
  throw new Error("Secure random generator unavailable for link code generation");
};

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

export const getConnectionByProviderAndExternalId = internalQuery({
  args: {
    provider: v.string(),
    externalUserId: v.string(),
  },
  returns: v.union(channelConnectionValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("channel_connections")
      .withIndex("by_provider_external", (q) =>
        q.eq("provider", args.provider).eq("externalUserId", args.externalUserId),
      )
      .first();
  },
});

export const getConnectionByOwnerProviderAndExternalId = internalQuery({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    externalUserId: v.string(),
  },
  returns: v.union(channelConnectionValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("channel_connections")
      .withIndex("by_owner_provider_external", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("provider", args.provider)
          .eq("externalUserId", args.externalUserId),
      )
      .first();
  },
});

export const getDmPolicyConfig = internalQuery({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  returns: v.object({
    policy: v.union(
      v.literal("pairing"),
      v.literal("allowlist"),
      v.literal("open"),
      v.literal("disabled"),
    ),
    allowlist: v.array(v.string()),
    denylist: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const policyKey = getDmPolicyKey(args.provider);
    const allowlistKey = getDmAllowlistKey(args.provider);
    const denylistKey = getDmDenylistKey(args.provider);

    const [policyPref, allowlistPref, denylistPref] = await Promise.all([
      ctx.db
        .query("user_preferences")
        .withIndex("by_owner_key", (q) =>
          q.eq("ownerId", args.ownerId).eq("key", policyKey),
        )
        .first(),
      ctx.db
        .query("user_preferences")
        .withIndex("by_owner_key", (q) =>
          q.eq("ownerId", args.ownerId).eq("key", allowlistKey),
        )
        .first(),
      ctx.db
        .query("user_preferences")
        .withIndex("by_owner_key", (q) =>
          q.eq("ownerId", args.ownerId).eq("key", denylistKey),
        )
        .first(),
    ]);

    return {
      policy: normalizeDmPolicy(policyPref?.value),
      allowlist: parseStringList(allowlistPref?.value),
      denylist: parseStringList(denylistPref?.value),
    };
  },
});

export const peekLinkCodeOwner = internalQuery({
  args: {
    provider: v.string(),
    code: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const key = `${args.provider}_link_code`;
    const prefs = await ctx.db
      .query("user_preferences")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();

    for (const pref of prefs) {
      try {
        const parsed = JSON.parse(pref.value) as { code: string; expiresAt: number };
        if (parsed.code === args.code && parsed.expiresAt > Date.now()) {
          return pref.ownerId;
        }
      } catch {
        // Ignore malformed entries.
      }
    }

    return null;
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
  returns: v.id("channel_connections"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("channel_connections")
      .withIndex("by_owner_provider_external", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("provider", args.provider)
          .eq("externalUserId", args.externalUserId),
      )
      .first();

    if (existing) {
      if (args.displayName && args.displayName !== existing.displayName) {
        await ctx.db.patch(existing._id, {
          displayName: args.displayName,
          updatedAt: now,
        });
      }
      return existing._id;
    }

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
  returns: v.id("conversations"),
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

export const createGroupConversation = internalMutation({
  args: {
    ownerId: v.string(),
    title: v.optional(v.string()),
  },
  returns: v.id("conversations"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("conversations", {
      ownerId: args.ownerId,
      title: args.title ?? "Group",
      isDefault: false,
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
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.connectionId, {
      conversationId: args.conversationId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const storeLinkCode = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    code: v.string(),
  },
  returns: v.null(),
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
    return null;
  },
});

export const consumeLinkCode = internalMutation({
  args: {
    provider: v.string(),
    code: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const key = `${args.provider}_link_code`;
    const prefs = await ctx.db
      .query("user_preferences")
      .withIndex("by_key", (q) => q.eq("key", key))
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

export const consumeWebhookRateLimit = internalMutation({
  args: {
    scope: v.string(),
    key: v.string(),
    limit: v.number(),
    windowMs: v.number(),
    blockMs: v.optional(v.number()),
  },
  returns: v.object({
    allowed: v.boolean(),
    retryAfterMs: v.number(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.floor(args.limit));
    const periodMs = Math.max(1_000, Math.floor(args.windowMs), Math.floor(args.blockMs ?? 0));
    const status = await webhookRateLimiter.limit(ctx, `webhook:${args.scope}:${limit}:${periodMs}`, {
      key: args.key,
      config: { kind: "fixed window", rate: limit, period: periodMs },
    });

    return status.ok
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: Math.max(1_000, status.retryAfter ?? periodMs) };
  },
});

// ---------------------------------------------------------------------------
// Public Queries/Mutations (for frontend)
// ---------------------------------------------------------------------------

export const generateLinkCode = mutation({
  args: { provider: v.string() },
  returns: v.object({ code: v.string() }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const code = generateSecureLinkCode(6);

    await ctx.runMutation(internal.channels.utils.storeLinkCode, {
      ownerId,
      provider: args.provider,
      code,
    });

    return { code };
  },
});

export const getConnection = query({
  args: { provider: v.string() },
  returns: v.union(channelConnectionValidator, v.null()),
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
  returns: v.null(),
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

export const getDmPolicy = internalQuery({
  args: { provider: v.string() },
  returns: v.object({
    policy: v.union(
      v.literal("pairing"),
      v.literal("allowlist"),
      v.literal("open"),
      v.literal("disabled"),
    ),
    allowlist: v.array(v.string()),
    denylist: v.array(v.string()),
  }),
  handler: async (ctx, args): Promise<{ policy: DmPolicy; allowlist: string[]; denylist: string[] }> => {
    const ownerId = await requireUserId(ctx);
    const policyKey = getDmPolicyKey(args.provider);
    const allowlistKey = getDmAllowlistKey(args.provider);
    const denylistKey = getDmDenylistKey(args.provider);

    const [policyPref, allowlistPref, denylistPref] = await Promise.all([
      ctx.db
        .query("user_preferences")
        .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", policyKey))
        .first(),
      ctx.db
        .query("user_preferences")
        .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", allowlistKey))
        .first(),
      ctx.db
        .query("user_preferences")
        .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", denylistKey))
        .first(),
    ]);

    return {
      policy: normalizeDmPolicy(policyPref?.value),
      allowlist: parseStringList(allowlistPref?.value),
      denylist: parseStringList(denylistPref?.value),
    };
  },
});

export const setDmPolicy = internalMutation({
  args: {
    provider: v.string(),
    policy: v.union(
      v.literal("pairing"),
      v.literal("allowlist"),
      v.literal("open"),
      v.literal("disabled"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const key = getDmPolicyKey(args.provider);
    const now = Date.now();

    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.policy,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId,
        key,
        value: args.policy,
        updatedAt: now,
      });
    }

    return null;
  },
});

export const setDmAllowlist = internalMutation({
  args: {
    provider: v.string(),
    externalUserIds: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const key = getDmAllowlistKey(args.provider);
    const value = JSON.stringify(uniqueSorted(args.externalUserIds));
    const now = Date.now();

    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt: now });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId,
        key,
        value,
        updatedAt: now,
      });
    }

    return null;
  },
});

export const setDmDenylist = internalMutation({
  args: {
    provider: v.string(),
    externalUserIds: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const key = getDmDenylistKey(args.provider);
    const value = JSON.stringify(uniqueSorted(args.externalUserIds));
    const now = Date.now();

    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt: now });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId,
        key,
        value,
        updatedAt: now,
      });
    }

    return null;
  },
});

// ---------------------------------------------------------------------------
// Shared Helper Functions (called from provider action handlers)
// ---------------------------------------------------------------------------

/**
 * Common message handling: lookup connection → resolve conversation →
 * append event → resolve execution target → run agent turn → return response.
 *
 * Conversation routing:
 *  - DMs (groupId absent): route to the owner's default conversation
 *  - Groups (groupId present): route to a per-group conversation
 */
export async function processIncomingMessage(args: {
  ctx: ActionCtx;
  ownerId?: string;
  provider: string;
  externalUserId: string;
  text: string;
  groupId?: string;
}): Promise<{ text: string } | null> {
  let connection = args.ownerId
    ? await args.ctx.runQuery(
        internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
        {
          ownerId: args.ownerId,
          provider: args.provider,
          externalUserId: args.externalUserId,
        },
      )
    : await args.ctx.runQuery(
        internal.channels.utils.getConnectionByProviderAndExternalId,
        { provider: args.provider, externalUserId: args.externalUserId },
      );

  const policyOwnerId = args.ownerId ?? connection?.ownerId;
  if (!policyOwnerId) return null;

  const policy = await args.ctx.runQuery(internal.channels.utils.getDmPolicyConfig, {
    ownerId: policyOwnerId,
    provider: args.provider,
  });

  if (policy.denylist.includes(args.externalUserId)) return null;
  if (policy.policy === "disabled") return null;
  if (policy.policy === "allowlist" && !policy.allowlist.includes(args.externalUserId)) {
    return null;
  }
  if (policy.policy === "pairing" && !connection) return null;

  if (!connection) {
    await args.ctx.runMutation(internal.channels.utils.createConnection, {
      ownerId: policyOwnerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
    });

    connection = await args.ctx.runQuery(
      internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
      {
        ownerId: policyOwnerId,
        provider: args.provider,
        externalUserId: args.externalUserId,
      },
    );
  }

  if (!connection) return null;

  // Conversation routing: DMs → default conversation, groups → per-group
  let conversationId: typeof connection.conversationId;

  if (args.groupId) {
    // Groups use a separate connection keyed by group ID to track per-group conversations
    const groupKey = `group:${args.groupId}`;
    let groupConnection = await args.ctx.runQuery(
      internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
      { ownerId: connection.ownerId, provider: args.provider, externalUserId: groupKey },
    );

    if (!groupConnection) {
      await args.ctx.runMutation(internal.channels.utils.createConnection, {
        ownerId: connection.ownerId,
        provider: args.provider,
        externalUserId: groupKey,
      });
      groupConnection = await args.ctx.runQuery(
        internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
        { ownerId: connection.ownerId, provider: args.provider, externalUserId: groupKey },
      );
    }

    if (groupConnection?.conversationId) {
      conversationId = groupConnection.conversationId;
    } else {
      conversationId = await args.ctx.runMutation(
        internal.channels.utils.createGroupConversation,
        { ownerId: connection.ownerId, title: `${args.provider} group` },
      );
      if (groupConnection) {
        await args.ctx.runMutation(internal.channels.utils.setConnectionConversation, {
          connectionId: groupConnection._id,
          conversationId,
        });
      }
    }
  } else {
    // DMs always go to the owner's default conversation
    conversationId = await args.ctx.runMutation(
      internal.channels.utils.getOrCreateConversationForOwner,
      { ownerId: connection.ownerId },
    );
  }

  await args.ctx.runMutation(internal.events.appendInternalEvent, {
    conversationId,
    type: "user_message",
    deviceId: `channel:${args.provider}`,
    payload: { text: args.text },
  });

  // Resolve execution target: local device if online, else cloud, else backend-only
  const { targetDeviceId, spriteName } = await args.ctx.runQuery(
    internal.agent.device_resolver.resolveExecutionTarget,
    { ownerId: connection.ownerId },
  );

  if (spriteName) {
    await args.ctx.runMutation(internal.agent.cloud_devices.touchActivity, {
      ownerId: connection.ownerId,
    });
  }

  const result = await runAgentTurn({
    ctx: args.ctx,
    conversationId,
    prompt: args.text,
    agentType: "orchestrator",
    ownerId: connection.ownerId,
    targetDeviceId: targetDeviceId ?? undefined,
    spriteName: spriteName ?? undefined,
  });

  const responseText = result.text.trim() || "(Stella had nothing to say.)";

  // Persist the assistant response so it appears in the desktop conversation
  if (!result.silent) {
    await args.ctx.runMutation(internal.events.appendInternalEvent, {
      conversationId,
      type: "assistant_message",
      payload: {
        text: responseText,
        source: `channel:${args.provider}`,
        ...(result.usage ? { usage: result.usage } : {}),
      },
    });
  }

  return { text: responseText };
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
}): Promise<"linked" | "already_linked" | "invalid_code" | "linking_disabled" | "not_allowed"> {
  const existing = await args.ctx.runQuery(
    internal.channels.utils.getConnectionByProviderAndExternalId,
    { provider: args.provider, externalUserId: args.externalUserId },
  );
  if (existing) return "already_linked";

  const ownerId = await args.ctx.runQuery(
    internal.channels.utils.peekLinkCodeOwner,
    { provider: args.provider, code: args.code },
  );
  if (!ownerId) return "invalid_code";

  const policy = await args.ctx.runQuery(internal.channels.utils.getDmPolicyConfig, {
    ownerId,
    provider: args.provider,
  });
  if (policy.policy === "disabled") return "linking_disabled";
  if (policy.denylist.includes(args.externalUserId)) return "not_allowed";
  if (policy.policy === "allowlist" && !policy.allowlist.includes(args.externalUserId)) {
    return "not_allowed";
  }

  const consumedOwnerId = await args.ctx.runMutation(
    internal.channels.utils.consumeLinkCode,
    { provider: args.provider, code: args.code },
  );
  if (!consumedOwnerId || consumedOwnerId !== ownerId) return "invalid_code";

  await args.ctx.runMutation(internal.channels.utils.createConnection, {
    ownerId,
    provider: args.provider,
    externalUserId: args.externalUserId,
    displayName: args.displayName,
  });
  return "linked";
}
