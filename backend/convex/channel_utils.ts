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

type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";

const DM_POLICY_DEFAULT: DmPolicy = "pairing";
const RATE_LIMIT_OWNER_ID = "__system_webhook_rate_limit__";

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

const rateLimitPrefKey = (scope: string, key: string) => `webhook_rate:${scope}:${key}`;

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

export const getConnectionByOwnerProviderAndExternalId = internalQuery({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    externalUserId: v.string(),
  },
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
  handler: async (ctx, args) => {
    const now = Date.now();
    const prefKey = rateLimitPrefKey(args.scope, args.key);
    const record = await ctx.db
      .query("user_preferences")
      .withIndex("by_owner_key", (q) =>
        q.eq("ownerId", RATE_LIMIT_OWNER_ID).eq("key", prefKey),
      )
      .first();

    let windowStartMs = now;
    let count = 0;
    let blockedUntilMs = 0;

    if (record) {
      try {
        const parsed = JSON.parse(record.value) as {
          windowStartMs?: number;
          count?: number;
          blockedUntilMs?: number;
        };
        if (typeof parsed.windowStartMs === "number") windowStartMs = parsed.windowStartMs;
        if (typeof parsed.count === "number") count = parsed.count;
        if (typeof parsed.blockedUntilMs === "number") blockedUntilMs = parsed.blockedUntilMs;
      } catch {
        // Ignore malformed previous state and reset below.
      }
    }

    if (blockedUntilMs > now) {
      return { allowed: false, retryAfterMs: blockedUntilMs - now };
    }

    if (now - windowStartMs >= args.windowMs) {
      windowStartMs = now;
      count = 0;
    }

    count += 1;
    if (count > args.limit) {
      blockedUntilMs = now + Math.max(1_000, args.blockMs ?? args.windowMs);
      const value = JSON.stringify({ windowStartMs, count, blockedUntilMs });

      if (record) {
        await ctx.db.patch(record._id, { value, updatedAt: now });
      } else {
        await ctx.db.insert("user_preferences", {
          ownerId: RATE_LIMIT_OWNER_ID,
          key: prefKey,
          value,
          updatedAt: now,
        });
      }

      return { allowed: false, retryAfterMs: blockedUntilMs - now };
    }

    const value = JSON.stringify({ windowStartMs, count, blockedUntilMs: 0 });
    if (record) {
      await ctx.db.patch(record._id, { value, updatedAt: now });
    } else {
      await ctx.db.insert("user_preferences", {
        ownerId: RATE_LIMIT_OWNER_ID,
        key: prefKey,
        value,
        updatedAt: now,
      });
    }

    return { allowed: true, retryAfterMs: 0 };
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

export const getDmPolicy = query({
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

export const setDmPolicy = mutation({
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

export const setDmAllowlist = mutation({
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

export const setDmDenylist = mutation({
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
 * append event → resolve cloud device → run agent turn → return response.
 */
export async function processIncomingMessage(args: {
  ctx: ActionCtx;
  ownerId?: string;
  provider: string;
  externalUserId: string;
  text: string;
}): Promise<{ text: string } | null> {
  let connection = args.ownerId
    ? await args.ctx.runQuery(
        internal.channel_utils.getConnectionByOwnerProviderAndExternalId,
        {
          ownerId: args.ownerId,
          provider: args.provider,
          externalUserId: args.externalUserId,
        },
      )
    : await args.ctx.runQuery(
        internal.channel_utils.getConnectionByProviderAndExternalId,
        { provider: args.provider, externalUserId: args.externalUserId },
      );

  const policyOwnerId = args.ownerId ?? connection?.ownerId;
  if (!policyOwnerId) return null;

  const policy = await args.ctx.runQuery(internal.channel_utils.getDmPolicyConfig, {
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
    await args.ctx.runMutation(internal.channel_utils.createConnection, {
      ownerId: policyOwnerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
    });

    connection = await args.ctx.runQuery(
      internal.channel_utils.getConnectionByOwnerProviderAndExternalId,
      {
        ownerId: policyOwnerId,
        provider: args.provider,
        externalUserId: args.externalUserId,
      },
    );
  }

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
}): Promise<"linked" | "already_linked" | "invalid_code" | "linking_disabled" | "not_allowed"> {
  const existing = await args.ctx.runQuery(
    internal.channel_utils.getConnectionByProviderAndExternalId,
    { provider: args.provider, externalUserId: args.externalUserId },
  );
  if (existing) return "already_linked";

  const ownerId = await args.ctx.runQuery(
    internal.channel_utils.peekLinkCodeOwner,
    { provider: args.provider, code: args.code },
  );
  if (!ownerId) return "invalid_code";

  const policy = await args.ctx.runQuery(internal.channel_utils.getDmPolicyConfig, {
    ownerId,
    provider: args.provider,
  });
  if (policy.policy === "disabled") return "linking_disabled";
  if (policy.denylist.includes(args.externalUserId)) return "not_allowed";
  if (policy.policy === "allowlist" && !policy.allowlist.includes(args.externalUserId)) {
    return "not_allowed";
  }

  const consumedOwnerId = await args.ctx.runMutation(
    internal.channel_utils.consumeLinkCode,
    { provider: args.provider, code: args.code },
  );
  if (!consumedOwnerId || consumedOwnerId !== ownerId) return "invalid_code";

  await args.ctx.runMutation(internal.channel_utils.createConnection, {
    ownerId,
    provider: args.provider,
    externalUserId: args.externalUserId,
    displayName: args.displayName,
  });
  return "linked";
}
