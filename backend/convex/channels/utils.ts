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
import { runAgentTurn, type RunAgentTurnResult } from "../automation/runner";
import { requireUserId } from "../auth";
import { optionalChannelEnvelopeValidator } from "../shared_validators";
import {
  CONNECTED_MODE_REQUIRED_ERROR,
  ensureOwnerConnection,
  evaluateLinkingDmPolicy,
  isOwnerInConnectedMode,
  resolveConnectionForIncomingMessage,
  type ChannelConnection,
  type DmPolicy,
} from "./routing_flow";

type RuntimeMode = "local" | "cloud_247";
type SyncMode = "on" | "off";
type ExecutionCandidate =
  | { mode: "local"; targetDeviceId: string; spriteName?: undefined }
  | { mode: "cloud"; targetDeviceId?: undefined; spriteName?: undefined }
  | { mode: "remote"; targetDeviceId?: undefined; spriteName: string };

const DM_POLICY_DEFAULT: DmPolicy = "pairing";
const SYNC_MODE_OFF: SyncMode = "off";
const OFFLINE_ENABLE_247_INTENT = /\b(enable|turn on|start)\s*(24\/?7|247|cloud)\b/i;
const CONNECTED_MODE_REQUIRED_MESSAGE =
  "Connectors are disabled in Private Local mode. Enable Connected mode in Stella Settings to continue.";
const OFFLINE_ENABLE_247_MESSAGE =
  "Your desktop is offline. Reply \"enable 24/7\" to start cloud mode, or open Stella on your desktop.";
const ENABLING_247_MESSAGE =
  "Turning on 24/7 mode now. Remote machine is provisioning. Please send your message again in a moment.";
const CLOUD_247_NOT_READY_MESSAGE =
  "24/7 mode is enabled, but the remote machine is not ready yet. Please try again shortly.";
const ENABLE_247_FAILED_MESSAGE =
  "I couldn't start 24/7 mode right now. Please enable it from Stella Settings and try again.";
const CLOUD_FALLBACK_NUDGE_MESSAGE =
  "Your desktop is offline right now. Reply \"enable 24/7\" if you want always-on remote execution.";
const LINK_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const TRANSIENT_CLEANUP_MAX_ATTEMPTS = 4;
const TRANSIENT_CLEANUP_BACKOFF_BASE_MS = 100;
const TRANSIENT_CLEANUP_BACKOFF_MAX_MS = 2_000;

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
  displayName?: string;
  preEnsureOwnerConnection?: boolean;
  respond?: boolean;
  /** Provider-specific delivery metadata for async connector delivery. */
  deliveryMeta?: Record<string, unknown>;
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
    .unique();

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
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length]).join("");
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const toErrorMessage = (value: unknown): string | undefined => {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
};

const getTransientCleanupBackoffMs = (attempt: number): number =>
  Math.min(
    TRANSIENT_CLEANUP_BACKOFF_MAX_MS,
    TRANSIENT_CLEANUP_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );

const isEnable247Intent = (text: string) => OFFLINE_ENABLE_247_INTENT.test(text.trim());

const buildExecutionCandidates = (args: {
  runtimeMode: RuntimeMode;
  targetDeviceId: string | null;
  spriteName: string | null;
}): ExecutionCandidate[] => {
  const candidates: ExecutionCandidate[] = [];
  if (args.targetDeviceId) {
    candidates.push({ mode: "local", targetDeviceId: args.targetDeviceId });
  }

  if (args.runtimeMode === "cloud_247") {
    if (args.spriteName) {
      candidates.push({ mode: "remote", spriteName: args.spriteName });
    }
    candidates.push({ mode: "cloud" });
    return candidates;
  }

  // runtimeMode === "local": prefer local when online, then cloud fallback, then remote.
  candidates.push({ mode: "cloud" });
  if (args.spriteName) {
    candidates.push({ mode: "remote", spriteName: args.spriteName });
  }
  return candidates;
};

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
  handler: async (ctx, args) => {
    return await ctx.db
      .query("channel_connections")
      .withIndex("by_provider_and_externalUserId", (q) =>
        q.eq("provider", args.provider).eq("externalUserId", args.externalUserId),
      )
      .unique();
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
      .withIndex("by_ownerId_and_provider_and_externalUserId", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("provider", args.provider)
          .eq("externalUserId", args.externalUserId),
      )
      .unique();
  },
});

export const getDmPolicyConfig = internalQuery({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
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
        .unique(),
      ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) =>
          q.eq("ownerId", args.ownerId).eq("key", allowlistKey),
        )
        .unique(),
      ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) =>
          q.eq("ownerId", args.ownerId).eq("key", denylistKey),
        )
        .unique(),
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
      .unique();

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
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_isDefault", (q) =>
        q.eq("ownerId", args.ownerId).eq("isDefault", true),
      )
      .unique();

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
      .unique();

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
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.floor(args.limit));
    const periodMs = Math.max(1_000, Math.floor(args.windowMs), Math.floor(args.blockMs ?? 0));
    const hashedKey = await hashSha256Hex(`${args.scope}:${args.key}`);
    const status = await webhookRateLimiter.limit(ctx, `webhook:${args.scope}:${limit}:${periodMs}`, {
      key: hashedKey,
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
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    if (!(await isOwnerInConnectedMode({ ctx, ownerId }))) {
      throw new Error(CONNECTED_MODE_REQUIRED_ERROR);
    }

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
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const ownerId = identity.subject;
    if (!(await isOwnerInConnectedMode({ ctx, ownerId }))) {
      return null;
    }

    return await ctx.db
      .query("channel_connections")
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", args.provider),
      )
      .unique();
  },
});

export const deleteConnection = mutation({
  args: { provider: v.string() },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const conn = await ctx.db
      .query("channel_connections")
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", ownerId).eq("provider", args.provider),
      )
      .unique();
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

export { ensureOwnerConnection };

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
    groupConnection = await ensureOwnerConnection({
      ctx: args.ctx,
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: groupKey,
    });
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
}): Promise<Id<"events"> | null> => {
  const event = await args.ctx.runMutation(internal.events.appendInternalEvent, {
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
  return event?._id ?? null;
};

const appendTransientChannelEvent = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  conversationId: Id<"conversations">;
  provider: string;
  direction: "inbound" | "outbound";
  text: string;
  batchKey: string;
  runId?: string;
  metadata?: {
    source?: string;
    syncMode?: string;
    runtimeMode?: string;
    fallback?: string;
  };
}): Promise<void> => {
  await args.ctx.runMutation(internal.channels.transient_data.appendTransientEvent, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    provider: args.provider,
    direction: args.direction,
    text: args.text,
    batchKey: args.batchKey,
    runId: args.runId,
    metadata: args.metadata,
  });
};

const deleteTransientBatch = async (args: {
  ctx: ActionCtx;
  batchKey: string;
}): Promise<void> => {
  await args.ctx.runMutation(internal.channels.transient_data.deleteTransientBatch, {
    batchKey: args.batchKey,
  });
};

const resolveExecutionTarget = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  transient?: boolean;
}): Promise<{ targetDeviceId: string | null; spriteName: string | null }> => {
  const target = await args.ctx.runQuery(
    internal.agent.device_resolver.resolveExecutionTarget,
    { ownerId: args.ownerId },
  );

  if (target.spriteName && !args.transient) {
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
): Promise<{ text: string; deferred?: boolean } | null> {
  if (args.ownerId && !(await isOwnerInConnectedMode({ ctx: args.ctx, ownerId: args.ownerId }))) {
    if (args.respond === false) {
      return { text: "" };
    }
    return { text: CONNECTED_MODE_REQUIRED_MESSAGE };
  }

  const connection = await resolveConnectionForIncomingMessage({
    ctx: args.ctx,
    ownerId: args.ownerId,
    provider: args.provider,
    externalUserId: args.externalUserId,
    displayName: args.displayName,
    preEnsureOwnerConnection: args.preEnsureOwnerConnection,
  });
  if (!connection) {
    return null;
  }

  if (!(await isOwnerInConnectedMode({ ctx: args.ctx, ownerId: connection.ownerId }))) {
    if (args.respond === false) {
      return { text: "" };
    }
    return { text: CONNECTED_MODE_REQUIRED_MESSAGE };
  }

  const conversationId = await resolveConversationIdForIncomingMessage({
    ctx: args.ctx,
    provider: args.provider,
    ownerId: connection.ownerId,
    groupId: args.groupId,
  });
  const runtimeMode = (await args.ctx.runQuery(
    internal.data.preferences.getRuntimeModeForOwner,
    { ownerId: connection.ownerId },
  )) as RuntimeMode;
  const syncMode = (await args.ctx.runQuery(
    internal.data.preferences.getSyncModeForOwner,
    { ownerId: connection.ownerId },
  )) as SyncMode;
  // See backend/docs/sync_off_operational_writes.md for intentionally retained
  // operational metadata writes while sync mode is off.
  const transient = syncMode === SYNC_MODE_OFF;
  const transientBatchKey = transient
    ? `channel:${args.provider}:${crypto.randomUUID()}`
    : null;
  let transientBatchCleaned = false;
  const cleanupTransientBatch = async () => {
    if (!transientBatchKey || transientBatchCleaned) {
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= TRANSIENT_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
      try {
        await deleteTransientBatch({ ctx: args.ctx, batchKey: transientBatchKey });
        transientBatchCleaned = true;
        return;
      } catch (cleanupError) {
        lastError = cleanupError;
        console.error(
          `[channels] Transient connector cleanup attempt ${attempt}/${TRANSIENT_CLEANUP_MAX_ATTEMPTS} failed:`,
          cleanupError,
        );
        if (attempt < TRANSIENT_CLEANUP_MAX_ATTEMPTS) {
          await sleep(getTransientCleanupBackoffMs(attempt));
        }
      }
    }

    const errorMessage = toErrorMessage(lastError);
    try {
      await args.ctx.runMutation(internal.channels.transient_data.recordCleanupFailure, {
        ownerId: connection.ownerId,
        conversationId,
        provider: args.provider,
        batchKey: transientBatchKey,
        attempts: TRANSIENT_CLEANUP_MAX_ATTEMPTS,
        errorMessage,
      });
    } catch (reportError) {
      console.error("[channels] Failed to persist transient cleanup failure metric:", reportError);
    }

    console.error("[channels][ALERT] Failed to clean transient connector batch after retries.", {
      ownerId: connection.ownerId,
      provider: args.provider,
      attempts: TRANSIENT_CLEANUP_MAX_ATTEMPTS,
      ...(errorMessage ? { errorMessage } : {}),
    });
  };

  const persistAssistant = async (params: {
    text: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    silent?: boolean;
    fallback?: string;
  }) => {
    if (params.silent) return;
    if (transient && transientBatchKey) {
      await appendTransientChannelEvent({
        ctx: args.ctx,
        ownerId: connection.ownerId,
        conversationId,
        provider: args.provider,
        direction: "outbound",
        text: params.text,
        batchKey: transientBatchKey,
        metadata: {
          source: "connector",
          syncMode,
          runtimeMode,
          ...(params.fallback ? { fallback: params.fallback } : {}),
        },
      });
      return;
    }

    await persistInboundAssistantMessage({
      ctx: args.ctx,
      conversationId,
      provider: args.provider,
      responseText: params.text,
      usage: params.usage,
    });
  };

  try {
    const userMessageId = transient
      ? null
      : await appendInboundUserMessage({
          ctx: args.ctx,
          conversationId,
          provider: args.provider,
          text: args.text,
          attachments: args.attachments,
          channelEnvelope: args.channelEnvelope,
        });

    if (transient && transientBatchKey) {
      await appendTransientChannelEvent({
        ctx: args.ctx,
        ownerId: connection.ownerId,
        conversationId,
        provider: args.provider,
        direction: "inbound",
        text: args.text,
        batchKey: transientBatchKey,
        metadata: {
          source: "connector",
          syncMode,
          runtimeMode,
        },
      });
    }

    if (args.respond === false) {
      return { text: "" };
    }

    const executionTarget = await resolveExecutionTarget({
      ctx: args.ctx,
      ownerId: connection.ownerId,
      transient,
    });

    // Special intent: allow users to enable 24/7 directly from connectors.
    if (
      runtimeMode === "local" &&
      !executionTarget.targetDeviceId &&
      isEnable247Intent(args.text)
    ) {
      try {
        await args.ctx.runAction(internal.agent.cloud_devices.spawnForOwner, {
          ownerId: connection.ownerId,
        });
      } catch (error) {
        console.error("[channels] Failed to enable 24/7 mode from connector:", error);
        await persistAssistant({ text: ENABLE_247_FAILED_MESSAGE });
        return { text: ENABLE_247_FAILED_MESSAGE };
      }

      await persistAssistant({ text: ENABLING_247_MESSAGE });
      return { text: ENABLING_247_MESSAGE };
    }

    const candidates = buildExecutionCandidates({
      runtimeMode,
      targetDeviceId: executionTarget.targetDeviceId,
      spriteName: executionTarget.spriteName,
    });

    // ─── Inverted Execution: defer to local device ──────────────────────
    // When the local device is online and delivery metadata is provided,
    // insert a remote_turn_request event and return immediately. The local
    // device runs the AI SDK natively (0ms tool latency) and delivers the
    // response back to the connector asynchronously.
    const firstCandidate = candidates[0];
    if (
      firstCandidate?.mode === "local" &&
      args.deliveryMeta &&
      userMessageId &&
      !transient
    ) {
      const requestId = crypto.randomUUID();

      await args.ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId,
        type: "remote_turn_request",
        targetDeviceId: firstCandidate.targetDeviceId,
        requestId,
        payload: {
          conversationId: String(conversationId),
          userMessageId: String(userMessageId),
          text: args.text,
          provider: args.provider,
          deliveryMeta: JSON.parse(JSON.stringify(args.deliveryMeta)),
        },
      });

      console.log(
        `[channels] Deferred to local device (inverted execution): ${requestId}`,
      );
      return { text: "", deferred: true };
    }

    let result: RunAgentTurnResult | null = null;
    let selectedMode: ExecutionCandidate["mode"] | null = null;
    let lastError: Error | null = null;
    for (const candidate of candidates) {
      try {
        result = await runAgentTurn({
          ctx: args.ctx,
          conversationId,
          prompt: args.text,
          agentType: "orchestrator",
          ownerId: connection.ownerId,
          userMessageId: userMessageId ?? undefined,
          targetDeviceId:
            candidate.mode === "local" ? candidate.targetDeviceId : undefined,
          spriteName:
            candidate.mode === "remote" ? candidate.spriteName : undefined,
          transient,
        });
        selectedMode = candidate.mode;
        break;
      } catch (error) {
        lastError = error as Error;
      }
    }

    if (!result) {
      if (lastError) {
        console.error("[channels] Agent turn failed across all execution candidates:", lastError);
      }
      const failureMessage =
        runtimeMode === "cloud_247"
          ? CLOUD_247_NOT_READY_MESSAGE
          : OFFLINE_ENABLE_247_MESSAGE;
      await persistAssistant({
        text: failureMessage,
        fallback: "none",
      });
      return { text: failureMessage };
    }

    let responseText = result.text.trim() || "(Stella had nothing to say.)";
    const usedCloudFallback =
      runtimeMode === "local" &&
      !executionTarget.targetDeviceId &&
      selectedMode === "cloud";
    if (usedCloudFallback) {
      responseText = `${responseText}\n\n${CLOUD_FALLBACK_NUDGE_MESSAGE}`;
    }

    await persistAssistant({
      text: responseText,
      usage: result.usage,
      silent: result.silent,
      fallback: usedCloudFallback ? "cloud" : selectedMode ?? undefined,
    });

    return { text: responseText };
  } catch (error) {
    console.error("[channels] processIncomingMessage failed:", error);
    return null;
  } finally {
    // Always clear transient connector rows, including unexpected error paths.
    await cleanupTransientBatch();
  }
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

  if (!(await isOwnerInConnectedMode({ ctx: args.ctx, ownerId }))) return "linking_disabled";

  const policy = await args.ctx.runQuery(internal.channels.utils.getDmPolicyConfig, {
    ownerId,
    provider: args.provider,
  });
  const linkingPolicyOutcome = evaluateLinkingDmPolicy({
    policy,
    externalUserId: args.externalUserId,
  });
  if (linkingPolicyOutcome) return linkingPolicyOutcome;

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
