import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { requireSensitiveUserIdAction } from "../auth";
import { processIncomingMessage } from "./message_pipeline";
import {
  CONNECTED_MODE_REQUIRED_ERROR,
  ensureOwnerConnection,
  isOwnerInConnectedMode,
} from "./routing_flow";
import {
  decryptSecret,
  encryptSecret,
} from "../data/secrets_crypto";
import {
  channelAttachmentValidator,
  optionalChannelEnvelopeValidator,
} from "../shared_validators";
import { WHATSAPP_BRIDGE_CODE } from "./bridge_code_whatsapp";
import { SIGNAL_BRIDGE_CODE } from "./bridge_code_signal";

const bridgeAuthStateValidator = v.optional(
  v.object({
    qrCode: v.optional(v.string()),
    linkUri: v.optional(v.string()),
    generatedAt: v.optional(v.number()),
    phoneNumber: v.optional(v.string()),
    externalUserId: v.optional(v.string()),
    displayName: v.optional(v.string()),
    jid: v.optional(v.string()),
    reason: v.optional(v.string()),
  }),
);

const HEARTBEAT_STALE_AFTER_MS = 3 * 60 * 1000;
const HEARTBEAT_STALE_REASON = "Bridge heartbeat timed out";

const decodeBridgeSession = async (
  session: Doc<"bridge_sessions"> | null,
) => {
  if (!session) {
    return null;
  }
  const webhookSecret = await decryptSecret(session.webhookSecret);
  return {
    ...session,
    webhookSecret,
  };
};

const decodeBridgeSessions = async (
  sessions: Array<Doc<"bridge_sessions">>,
) =>
  await Promise.all(
    sessions.map(async (session) => {
      const webhookSecret = await decryptSecret(session.webhookSecret);
      return {
        ...session,
        webhookSecret,
      };
    }),
  );

const setupBridgeResultValidator = v.union(
  v.object({
    status: v.literal("already_running"),
    sessionId: v.id("bridge_sessions"),
  }),
  v.object({
    status: v.literal("initializing"),
    sessionId: v.id("bridge_sessions"),
  }),
);

const stopBridgeResultValidator = v.union(
  v.object({ status: v.literal("not_running") }),
  v.object({ status: v.literal("stopped") }),
);

type SetupBridgeResult =
  | { status: "already_running"; sessionId: Id<"bridge_sessions"> }
  | { status: "initializing"; sessionId: Id<"bridge_sessions"> };

type StopBridgeResult = { status: "not_running" } | { status: "stopped" };

function getBridgeServiceCode(provider: string): string {
  if (provider === "whatsapp") return WHATSAPP_BRIDGE_CODE;
  if (provider === "signal") return SIGNAL_BRIDGE_CODE;
  throw new Error(`Unknown bridge provider: ${provider}`);
}

function getBridgeDependencies(provider: string): string {
  if (provider === "whatsapp") {
    return "@whiskeysockets/baileys@6.7.16 qrcode@1.5.4 pino@9.9.5";
  }
  if (provider === "signal") return "";
  return "";
}

function generateBridgeWebhookSecret(): string {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

const buildBridgeRuntimeEnv = (args: {
  ownerId: string;
  webhookSecret: string;
}): Record<string, string> => ({
  STELLA_BRIDGE_WEBHOOK_URL: `${process.env.CONVEX_SITE_URL}/api/webhooks/bridge`,
  STELLA_BRIDGE_POLL_URL: `${process.env.CONVEX_SITE_URL}/api/bridge/poll`,
  STELLA_BRIDGE_WEBHOOK_SECRET: args.webhookSecret,
  STELLA_BRIDGE_OWNER_ID: args.ownerId,
});

export const getBridgeSession = internalQuery({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("bridge_sessions")
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .unique();
    return await decodeBridgeSession(session);
  },
});

export const hasActiveBridgeForOwner = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("bridge_sessions")
      .withIndex("by_ownerId_and_provider", (q) => q.eq("ownerId", args.ownerId))
      .collect();
    return sessions.some(
      (session) =>
        session.status === "connected" ||
        session.status === "awaiting_auth" ||
        session.status === "initializing",
    );
  },
});

export const listAllBridgeSessions = internalQuery({
  args: {},
  handler: async (ctx) => {
    const sessions = await ctx.db.query("bridge_sessions").collect();
    return await decodeBridgeSessions(sessions);
  },
});

export const createBridgeSession = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const encrypted = await encryptSecret(generateBridgeWebhookSecret());
    return await ctx.db.insert("bridge_sessions", {
      ownerId: args.ownerId,
      provider: args.provider,
      status: "initializing",
      webhookSecret: JSON.stringify(encrypted),
      webhookSecretKeyVersion: encrypted.keyVersion,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateBridgeSession = internalMutation({
  args: {
    id: v.id("bridge_sessions"),
    status: v.optional(v.string()),
    authState: bridgeAuthStateValidator,
    errorMessage: v.optional(v.string()),
    lastHeartbeatAt: v.optional(v.number()),
    lastMessageAtMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.authState !== undefined) patch.authState = args.authState;
    if (args.errorMessage !== undefined) patch.errorMessage = args.errorMessage;
    if (args.lastHeartbeatAt !== undefined) patch.lastHeartbeatAt = args.lastHeartbeatAt;
    if (args.lastMessageAtMs !== undefined) patch.lastMessageAtMs = args.lastMessageAtMs;
    await ctx.db.patch(args.id, patch);
    return null;
  },
});

export const deleteBridgeSession = internalMutation({
  args: { id: v.id("bridge_sessions") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (doc) {
      await ctx.db.delete(args.id);
    }
    return null;
  },
});

export const getBridgeStatus = query({
  args: { provider: v.string() },
  returns: v.union(v.null(), v.object({
    _id: v.id("bridge_sessions"),
    _creationTime: v.number(),
    ownerId: v.string(),
    provider: v.string(),
    status: v.string(),
    authState: bridgeAuthStateValidator,
    errorMessage: v.optional(v.string()),
    lastHeartbeatAt: v.optional(v.number()),
    lastMessageAtMs: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    if (!(await isOwnerInConnectedMode({ ctx, ownerId: identity.subject }))) {
      return null;
    }
    const session = await ctx.db
      .query("bridge_sessions")
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", identity.subject).eq("provider", args.provider),
      )
      .unique();
    if (!session) {
      return null;
    }
    return {
      _id: session._id,
      _creationTime: session._creationTime,
      ownerId: session.ownerId,
      provider: session.provider,
      status: session.status,
      authState: session.authState,
      errorMessage: session.errorMessage,
      lastHeartbeatAt: session.lastHeartbeatAt,
      lastMessageAtMs: session.lastMessageAtMs,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  },
});

export const bridgeMaintenanceTick = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const staleThreshold = now - HEARTBEAT_STALE_AFTER_MS;
    const sessions = await ctx.runQuery(internal.channels.bridge.listAllBridgeSessions, {});

    for (const session of sessions) {
      if (session.status !== "connected") continue;
      const lastHeartbeatAt = session.lastHeartbeatAt ?? session.updatedAt;
      if (lastHeartbeatAt >= staleThreshold) continue;

      await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
        id: session._id,
        status: "disconnected",
        errorMessage: HEARTBEAT_STALE_REASON,
      });
    }

    await ctx.runMutation(internal.channels.bridge_outbound.gc, {});
    return null;
  },
});

export const setupBridge = action({
  args: { provider: v.string() },
  returns: setupBridgeResultValidator,
  handler: async (ctx, args): Promise<SetupBridgeResult> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    if (!(await isOwnerInConnectedMode({ ctx, ownerId }))) {
      throw new Error(CONNECTED_MODE_REQUIRED_ERROR);
    }

    const existing = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId,
      provider: args.provider,
    });
    if (
      existing &&
      existing.status !== "error" &&
      existing.status !== "stopped"
    ) {
      return { status: "already_running", sessionId: existing._id };
    }

    if (existing) {
      await ctx.runMutation(internal.channels.bridge.deleteBridgeSession, { id: existing._id });
    }

    const sessionId = await ctx.runMutation(internal.channels.bridge.createBridgeSession, {
      ownerId,
      provider: args.provider,
    });
    return { status: "initializing", sessionId };
  },
});

export const stopBridge = action({
  args: { provider: v.string() },
  returns: stopBridgeResultValidator,
  handler: async (ctx, args): Promise<StopBridgeResult> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId,
      provider: args.provider,
    });
    if (!session) return { status: "not_running" };

    await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
      id: session._id,
      status: "stopped",
    });
    return { status: "stopped" };
  },
});

export const getBridgeBundle = action({
  args: { provider: v.string() },
  returns: v.object({
    code: v.string(),
    env: v.record(v.string(), v.string()),
    dependencies: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ code: string; env: Record<string, string>; dependencies: string }> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    if (!(await isOwnerInConnectedMode({ ctx, ownerId }))) {
      throw new Error(CONNECTED_MODE_REQUIRED_ERROR);
    }
    const session: { webhookSecret: string } | null = await ctx.runQuery(
      internal.channels.bridge.getBridgeSession,
      {
        ownerId,
        provider: args.provider,
      },
    );
    if (!session) {
      throw new Error(`No bridge session found for ${args.provider}`);
    }

    return {
      code: getBridgeServiceCode(args.provider),
      env: buildBridgeRuntimeEnv({
        ownerId,
        webhookSecret: session.webhookSecret,
      }),
      dependencies: getBridgeDependencies(args.provider),
    };
  },
});

export const handleHeartbeat = internalAction({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId: args.ownerId,
      provider: args.provider,
    });
    if (!session) return null;

    await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
      id: session._id,
      lastHeartbeatAt: Date.now(),
      ...(session.status === "disconnected" ? { status: "connected" } : {}),
    });
    return null;
  },
});

export const handleAuthUpdate = internalAction({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    authState: v.object({
      qrCode: v.optional(v.string()),
      linkUri: v.optional(v.string()),
      generatedAt: v.optional(v.number()),
      phoneNumber: v.optional(v.string()),
      externalUserId: v.optional(v.string()),
      displayName: v.optional(v.string()),
      jid: v.optional(v.string()),
      reason: v.optional(v.string()),
    }),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId: args.ownerId,
      provider: args.provider,
    });
    if (!session) return null;

    await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
      id: session._id,
      status: args.status,
      authState: args.authState,
    });

    if (args.status === "connected") {
      const externalId =
        (args.authState as Record<string, string>)?.phoneNumber ??
        (args.authState as Record<string, string>)?.externalUserId ??
        "";

      if (externalId) {
        await ensureOwnerConnection({
          ctx,
          ownerId: args.ownerId,
          provider: args.provider,
          externalUserId: externalId,
          displayName: (args.authState as Record<string, string>)?.displayName,
        });
      }
    }

    return null;
  },
});

export const handleBridgeMessage = internalAction({
  args: {
    provider: v.string(),
    ownerId: v.string(),
    externalUserId: v.string(),
    text: v.string(),
    displayName: v.optional(v.string()),
    groupId: v.optional(v.string()),
    attachments: v.optional(v.array(channelAttachmentValidator)),
    channelEnvelope: optionalChannelEnvelopeValidator,
    respond: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const hasText = args.text.trim().length > 0;
    const hasAttachments = (args.attachments?.length ?? 0) > 0;
    const hasEnvelopeEvent = Boolean(args.channelEnvelope?.kind);
    if (!args.externalUserId || (!hasText && !hasAttachments && !hasEnvelopeEvent)) {
      return null;
    }

    const effectiveText =
      hasText
        ? args.text
        : args.channelEnvelope?.text?.trim() ||
          `[${args.channelEnvelope?.kind ?? "message"}]`;

    const result = await processIncomingMessage({
      ctx,
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
      text: effectiveText,
      displayName: args.displayName,
      groupId: args.groupId,
      attachments: args.attachments,
      channelEnvelope: args.channelEnvelope,
      preEnsureOwnerConnection: true,
      respond: args.respond,
      deliveryMeta: {
        ownerId: args.ownerId,
        externalUserId: args.externalUserId,
      },
    });

    if (result?.deferred) return null;
    if (!result) return null;

    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId: args.ownerId,
      provider: args.provider,
    });
    if (!session) {
      console.error(`[bridge] No session found for ${args.provider}/${args.ownerId}`);
      return null;
    }

    await ctx.runMutation(internal.channels.bridge_outbound.enqueue, {
      sessionId: session._id,
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
      text: result.text,
    });

    await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
      id: session._id,
      lastMessageAtMs: Date.now(),
    });

    if (args.respond === false || !result.text.trim()) {
      return null;
    }

    return null;
  },
});

export const handleBridgeError = internalAction({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId: args.ownerId,
      provider: args.provider,
    });
    if (!session) return null;

    console.error(`[bridge] Error from ${args.provider} bridge:`, args.error);
    await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
      id: session._id,
      status: "error",
      errorMessage: args.error,
    });
    return null;
  },
});
