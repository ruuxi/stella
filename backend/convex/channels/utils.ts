import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import { components, internal } from "../_generated/api";
import { v, Infer } from "convex/values";
import { RateLimiter } from "@convex-dev/rate-limiter";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { runAgentTurn } from "../automation/runner";
import { requireUserId } from "../auth";
import { optionalChannelEnvelopeValidator } from "../shared_validators";

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
type ChannelConnection = Infer<typeof channelConnectionValidator>;

type ChannelInboundAttachment = {
  id?: string;
  name?: string;
  mimeType?: string;
  url?: string;
  size?: number;
  kind?: string;
};

type ProcessIncomingMessageArgs = {
  ctx: ActionCtx;
  ownerId?: string;
  provider: string;
  externalUserId: string;
  text: string;
  groupId?: string;
  attachments?: ChannelInboundAttachment[];
  channelEnvelope?: Infer<typeof optionalChannelEnvelopeValidator>;
  respond?: boolean;
};

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

const upsertUserPreference = async (
  ctx: MutationCtx,
  ownerId: string,
  key: string,
  value: string,
) => {
  const updatedAt = Date.now();
  const existing = await ctx.db
    .query("user_preferences")
    .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, { value, updatedAt });
    return;
  }

  await ctx.db.insert("user_preferences", {
    ownerId,
    key,
    value,
    updatedAt,
  });
};

const webhookRateLimiter = new RateLimiter(components.rateLimiter);

const generateSecureLinkCode = (length = 6): string => {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length]).join("");
  }
  throw new Error("Secure random generator unavailable for link code generation");
};

const hashSha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const linkCodeSalt = () => generateSecureLinkCode(16);

const hashLinkCode = async (code: string, salt: string) =>
  hashSha256Hex(`${salt}:${code}`);

const parseLinkCodeValue = (
  value: string,
): {
  codeHash?: string;
  codeSalt?: string;
  expiresAt?: number;
} | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as {
      codeHash?: string;
      codeSalt?: string;
      expiresAt?: number;
    };
  } catch {
    return null;
  }
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
      .withIndex("by_provider_and_externalUserId", (q) =>
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
      .withIndex("by_ownerId_and_provider_and_externalUserId", (q) =>
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
        .withIndex("by_ownerId_and_key", (q) =>
          q.eq("ownerId", args.ownerId).eq("key", policyKey),
        )
        .first(),
      ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) =>
          q.eq("ownerId", args.ownerId).eq("key", allowlistKey),
        )
        .first(),
      ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) =>
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
    const now = Date.now();

    for (const pref of prefs) {
      const parsed = parseLinkCodeValue(pref.value);
      if (!parsed) {
        continue;
      }

      if (
        !parsed.codeHash ||
        !parsed.codeSalt ||
        typeof parsed.expiresAt !== "number" ||
        parsed.expiresAt <= now
      ) {
        continue;
      }

      const candidateHash = await hashLinkCode(args.code, parsed.codeSalt);
      if (candidateHash === parsed.codeHash) {
        return pref.ownerId;
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
      .withIndex("by_ownerId_and_provider_and_externalUserId", (q) =>
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

    const connectionId = await ctx.db.insert("channel_connections", {
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
      displayName: args.displayName,
      linkedAt: now,
      updatedAt: now,
    });
    return connectionId;
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
      .withIndex("by_ownerId_and_isDefault", (q) =>
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
    const salt = linkCodeSalt();
    const codeHash = await hashLinkCode(args.code, salt);
    const value = JSON.stringify({
      codeHash,
      codeSalt: salt,
      expiresAt: now + 5 * 60 * 1000,
    });

    const existing = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.ownerId).eq("key", key))
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
    const now = Date.now();

    for (const pref of prefs) {
      const parsed = parseLinkCodeValue(pref.value);
      if (!parsed) {
        continue;
      }

      if (
        !parsed.codeHash ||
        !parsed.codeSalt ||
        typeof parsed.expiresAt !== "number" ||
        parsed.expiresAt <= now
      ) {
        continue;
      }

      const candidateHash = await hashLinkCode(args.code, parsed.codeSalt);
      if (candidateHash === parsed.codeHash) {
        await ctx.db.delete(pref._id);
        return pref.ownerId;
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
      .withIndex("by_ownerId_and_provider", (q) =>
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
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", args.provider),
      )
      .first();
    if (conn) {
      await ctx.db.delete(conn._id);
    }
    return null;
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
    await upsertUserPreference(ctx, ownerId, key, args.policy);

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
    await upsertUserPreference(ctx, ownerId, key, value);

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
    await upsertUserPreference(ctx, ownerId, key, value);

    return null;
  },
});

// ---------------------------------------------------------------------------
// Shared Helper Functions (called from provider action handlers)
// ---------------------------------------------------------------------------

/**
 * Internal helpers for inbound channel message processing.
 */
const findConnection = async (args: {
  ctx: ActionCtx;
  ownerId?: string;
  provider: string;
  externalUserId: string;
}): Promise<ChannelConnection | null> => {
  if (args.ownerId) {
    return await args.ctx.runQuery(
      internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
      {
        ownerId: args.ownerId,
        provider: args.provider,
        externalUserId: args.externalUserId,
      },
    );
  }

  return await args.ctx.runQuery(
    internal.channels.utils.getConnectionByProviderAndExternalId,
    { provider: args.provider, externalUserId: args.externalUserId },
  );
};

const shouldBlockInboundByDmPolicy = (args: {
  policy: { policy: DmPolicy; allowlist: string[]; denylist: string[] };
  externalUserId: string;
  hasExistingConnection: boolean;
}): boolean => {
  if (args.policy.denylist.includes(args.externalUserId)) return true;
  if (args.policy.policy === "disabled") return true;
  if (
    args.policy.policy === "allowlist" &&
    !args.policy.allowlist.includes(args.externalUserId)
  ) {
    return true;
  }
  if (args.policy.policy === "pairing" && !args.hasExistingConnection) {
    return true;
  }
  return false;
};

const resolveConnectionForIncomingMessage = async (args: {
  ctx: ActionCtx;
  ownerId?: string;
  provider: string;
  externalUserId: string;
}): Promise<ChannelConnection | null> => {
  let connection = await findConnection(args);
  const policyOwnerId = args.ownerId ?? connection?.ownerId;
  if (!policyOwnerId) {
    return null;
  }

  const policy = await args.ctx.runQuery(internal.channels.utils.getDmPolicyConfig, {
    ownerId: policyOwnerId,
    provider: args.provider,
  });
  if (
    shouldBlockInboundByDmPolicy({
      policy,
      externalUserId: args.externalUserId,
      hasExistingConnection: Boolean(connection),
    })
  ) {
    return null;
  }

  if (connection) {
    return connection;
  }

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
  return connection;
};

const resolveConversationIdForIncomingMessage = async (args: {
  ctx: ActionCtx;
  provider: string;
  ownerId: string;
  groupId?: string;
}): Promise<Id<"conversations">> => {
  if (!args.groupId) {
    return await args.ctx.runMutation(
      internal.channels.utils.getOrCreateConversationForOwner,
      { ownerId: args.ownerId },
    );
  }

  const groupKey = `group:${args.groupId}`;
  let groupConnection = await args.ctx.runQuery(
    internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
    {
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: groupKey,
    },
  );

  if (!groupConnection) {
    await args.ctx.runMutation(internal.channels.utils.createConnection, {
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: groupKey,
    });
    groupConnection = await args.ctx.runQuery(
      internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
      {
        ownerId: args.ownerId,
        provider: args.provider,
        externalUserId: groupKey,
      },
    );
  }

  if (groupConnection?.conversationId) {
    return groupConnection.conversationId;
  }

  const conversationId = await args.ctx.runMutation(
    internal.channels.utils.createGroupConversation,
    { ownerId: args.ownerId, title: `${args.provider} group` },
  );

  if (groupConnection) {
    await args.ctx.runMutation(internal.channels.utils.setConnectionConversation, {
      connectionId: groupConnection._id,
      conversationId,
    });
  }

  return conversationId;
};

const appendInboundUserMessage = async (args: {
  ctx: ActionCtx;
  conversationId: Id<"conversations">;
  provider: string;
  text: string;
  attachments?: ChannelInboundAttachment[];
  channelEnvelope?: Infer<typeof optionalChannelEnvelopeValidator>;
}): Promise<void> => {
  await args.ctx.runMutation(internal.events.appendInternalEvent, {
    conversationId: args.conversationId,
    type: "user_message",
    deviceId: `channel:${args.provider}`,
    payload: {
      text: args.text,
      source: `channel:${args.provider}`,
      ...(args.attachments && args.attachments.length > 0
        ? { attachments: args.attachments }
        : {}),
    },
    channelEnvelope: args.channelEnvelope,
  });
};

const resolveExecutionTarget = async (args: {
  ctx: ActionCtx;
  ownerId: string;
}): Promise<{ targetDeviceId: string | null; spriteName: string | null }> => {
  const target = await args.ctx.runQuery(
    internal.agent.device_resolver.resolveExecutionTarget,
    { ownerId: args.ownerId },
  );

  if (target.spriteName) {
    await args.ctx.runMutation(internal.agent.cloud_devices.touchActivity, {
      ownerId: args.ownerId,
    });
  }

  return target;
};

const persistInboundAssistantMessage = async (args: {
  ctx: ActionCtx;
  conversationId: Id<"conversations">;
  provider: string;
  responseText: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}): Promise<void> => {
  await args.ctx.runMutation(internal.events.appendInternalEvent, {
    conversationId: args.conversationId,
    type: "assistant_message",
    payload: {
      text: args.responseText,
      source: `channel:${args.provider}`,
      ...(args.usage ? { usage: args.usage } : {}),
    },
  });
};

/**
 * Common message handling: lookup connection -> resolve conversation ->
 * append event -> resolve execution target -> run agent turn -> return response.
 *
 * Conversation routing:
 * - DMs (groupId absent): route to the owner's default conversation
 * - Groups (groupId present): route to a per-group conversation
 */
export async function processIncomingMessage(
  args: ProcessIncomingMessageArgs,
): Promise<{ text: string } | null> {
  const connection = await resolveConnectionForIncomingMessage({
    ctx: args.ctx,
    ownerId: args.ownerId,
    provider: args.provider,
    externalUserId: args.externalUserId,
  });
  if (!connection) {
    return null;
  }

  const conversationId = await resolveConversationIdForIncomingMessage({
    ctx: args.ctx,
    provider: args.provider,
    ownerId: connection.ownerId,
    groupId: args.groupId,
  });

  await appendInboundUserMessage({
    ctx: args.ctx,
    conversationId,
    provider: args.provider,
    text: args.text,
    attachments: args.attachments,
    channelEnvelope: args.channelEnvelope,
  });

  if (args.respond === false) {
    return { text: "" };
  }

  const executionTarget = await resolveExecutionTarget({
    ctx: args.ctx,
    ownerId: connection.ownerId,
  });

  const result = await runAgentTurn({
    ctx: args.ctx,
    conversationId,
    prompt: args.text,
    agentType: "orchestrator",
    ownerId: connection.ownerId,
    targetDeviceId: executionTarget.targetDeviceId ?? undefined,
    spriteName: executionTarget.spriteName ?? undefined,
  });

  const responseText = result.text.trim() || "(Stella had nothing to say.)";
  if (!result.silent) {
    await persistInboundAssistantMessage({
      ctx: args.ctx,
      conversationId,
      provider: args.provider,
      responseText,
      usage: result.usage,
    });
  }

  return { text: responseText };
}
/**
 * Common link code validation: consume code -> check existing ->
 * create connection -> return status.
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
