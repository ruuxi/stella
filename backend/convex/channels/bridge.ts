import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
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
  getSpritesTokenForOwner,
  spritesExec,
  spritesExecChecked,
} from "../agent/cloud_devices";
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

const decodedBridgeSessionValidator = v.object({
  _id: v.id("bridge_sessions"),
  _creationTime: v.number(),
  ownerId: v.string(),
  provider: v.string(),
  spriteName: v.optional(v.string()),
  mode: v.optional(v.string()),
  status: v.string(),
  webhookSecret: v.string(),
  webhookSecretKeyVersion: v.optional(v.number()),
  authState: bridgeAuthStateValidator,
  errorMessage: v.optional(v.string()),
  lastHeartbeatAt: v.optional(v.number()),
  lastMessageAtMs: v.optional(v.number()),
  nextWakeAtMs: v.optional(v.number()),
  wakeIntervalMs: v.optional(v.number()),
  wakeTier: v.optional(v.string()),
  consecutiveEmptyWakes: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

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
) => {
  return await Promise.all(
    sessions.map(async (session) => {
      const webhookSecret = await decryptSecret(session.webhookSecret);
      return {
        ...session,
        webhookSecret,
      };
    }),
  );
};

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

// ---------------------------------------------------------------------------
// Bridge service code templates
// ---------------------------------------------------------------------------

function getBridgeServiceCode(provider: string): string {
  if (provider === "whatsapp") return WHATSAPP_BRIDGE_CODE;
  if (provider === "signal") return SIGNAL_BRIDGE_CODE;
  throw new Error(`Unknown bridge provider: ${provider}`);
}

function getBridgeDependencies(provider: string): string {
  if (provider === "whatsapp") {
    return "@whiskeysockets/baileys@6.7.16 qrcode@1.5.4 pino@9.9.5";
  }
  if (provider === "signal") return ""; // signal-cli is a standalone binary
  return "";
}

function generateBridgeWebhookSecret(): string {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const buildBridgeRuntimeEnv = (args: {
  ownerId: string;
  webhookSecret: string;
}): Record<string, string> => ({
  STELLA_BRIDGE_WEBHOOK_URL: `${process.env.CONVEX_SITE_URL}/api/webhooks/bridge`,
  STELLA_BRIDGE_POLL_URL: `${process.env.CONVEX_SITE_URL}/api/bridge/poll`,
  STELLA_BRIDGE_WEBHOOK_SECRET: args.webhookSecret,
  STELLA_BRIDGE_OWNER_ID: args.ownerId,
});

const buildBridgeStartCommand = (env: Record<string, string>): string => {
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellSingleQuote(value)}`)
    .join(" ");
  return `cd /home/sprite/stella-bridge && ${envPrefix} nohup node bridge.js > bridge.log 2>&1 &`;
};

// ---------------------------------------------------------------------------
// Adaptive Wake — AIMD with recency-based tiers
// ---------------------------------------------------------------------------

const WAKE_TIERS = [
  { name: "HOT",    maxAgeMs: 2 * 60_000,     floorMs: 15_000,  ceilingMs: 20_000  },
  { name: "WARM",   maxAgeMs: 10 * 60_000,    floorMs: 30_000,  ceilingMs: 60_000  },
  { name: "COOL",   maxAgeMs: 60 * 60_000,    floorMs: 60_000,  ceilingMs: 120_000 },
  { name: "COLD",   maxAgeMs: 4 * 3_600_000,  floorMs: 120_000, ceilingMs: 300_000 },
  { name: "FROZEN", maxAgeMs: Infinity,        floorMs: 300_000, ceilingMs: 600_000 },
] as const;

const WAKE_ADDITIVE_STEP_MS = 10_000;
const WAKE_NIGHT_MULTIPLIER = 2;
const HEARTBEAT_STALE_AFTER_MS = 3 * 60_000;
const HEARTBEAT_STALE_REASON = "Bridge heartbeat timed out";

type WakeTierName = (typeof WAKE_TIERS)[number]["name"];
const DEVICE_RUNNING_SESSION_STATUSES = new Set([
  "connected",
  "awaiting_auth",
  "initializing",
]);
const DEVICE_SLEEPING_SESSION_STATUSES = new Set([
  "error",
  "disconnected",
  "stopped",
  "logged_out",
]);
const AGGRESSIVE_WAKE_TIERS = new Set<WakeTierName>(["COOL", "COLD", "FROZEN"]);

function computeWakeInterval(
  lastMessageAtMs: number | undefined,
  consecutiveEmptyWakes: number,
  nowMs: number,
): { intervalMs: number; tier: WakeTierName } {
  const sinceLastMsg = lastMessageAtMs ? nowMs - lastMessageAtMs : Infinity;

  // Determine tier from recency
  const tier =
    WAKE_TIERS.find((t) => sinceLastMsg < t.maxAgeMs) ?? WAKE_TIERS[WAKE_TIERS.length - 1];

  // AIMD: additive increase from tier floor based on consecutive empty wakes
  let intervalMs = tier.floorMs + consecutiveEmptyWakes * WAKE_ADDITIVE_STEP_MS;
  intervalMs = Math.max(tier.floorMs, Math.min(tier.ceilingMs, intervalMs));

  // Time-of-day: stretch COOL/COLD/FROZEN during night hours (1am–6am UTC)
  const hour = new Date(nowMs).getUTCHours();
  if (hour >= 1 && hour < 6 && (tier.name === "COOL" || tier.name === "COLD" || tier.name === "FROZEN")) {
    intervalMs = Math.min(tier.ceilingMs * WAKE_NIGHT_MULTIPLIER, intervalMs * WAKE_NIGHT_MULTIPLIER);
  }

  // Jitter ±15%
  const jitter = 1 + (Math.random() * 0.3 - 0.15);
  intervalMs = Math.round(intervalMs * jitter);

  // Final clamp
  intervalMs = Math.max(WAKE_TIERS[0].floorMs, Math.min(WAKE_TIERS[WAKE_TIERS.length - 1].ceilingMs * WAKE_NIGHT_MULTIPLIER, intervalMs));

  return { intervalMs, tier: tier.name };
}

async function setCloudDeviceRunning(ctx: ActionCtx, ownerId: string): Promise<void> {
  const device = await ctx.runQuery(internal.agent.cloud_devices.getForOwner, { ownerId });
  if (!device || device.status === "running" || device.status === "error") {
    return;
  }
  await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
    id: device._id,
    status: "running",
  });
}

async function setCloudDeviceSleepingIfNoActiveBridge(
  ctx: ActionCtx,
  ownerId: string,
): Promise<void> {
  const hasActiveBridge = await ctx.runQuery(internal.channels.bridge.hasActiveBridgeForOwner, {
    ownerId,
  });
  if (hasActiveBridge) {
    return;
  }
  const device = await ctx.runQuery(internal.agent.cloud_devices.getForOwner, { ownerId });
  if (!device || device.status === "sleeping" || device.status === "error") {
    return;
  }
  await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
    id: device._id,
    status: "sleeping",
  });
}

async function scheduleWake(
  ctx: ActionCtx,
  sessionId: Id<"bridge_sessions">,
  consecutiveEmptyWakes: number,
): Promise<void> {
  const nextWake = await ctx.runMutation(internal.channels.bridge.scheduleNextWake, {
    id: sessionId,
    consecutiveEmptyWakes,
  });
  await ctx.scheduler.runAfter(nextWake.intervalMs, internal.channels.bridge.wakeSprite, {
    sessionId,
    dueAtMs: nextWake.dueAtMs,
  });
}

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

export const getBridgeSession = internalQuery({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  returns: v.union(v.null(), decodedBridgeSessionValidator),
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

export const getBridgeSessionById = internalQuery({
  args: { id: v.id("bridge_sessions") },
  returns: v.union(v.null(), decodedBridgeSessionValidator),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    return await decodeBridgeSession(session);
  },
});

export const hasActiveBridgeForOwner = internalQuery({
  args: { ownerId: v.string() },
  returns: v.boolean(),
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

// ---------------------------------------------------------------------------
// Internal Mutations
// ---------------------------------------------------------------------------

export const createBridgeSession = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    spriteName: v.optional(v.string()),
    mode: v.optional(v.string()),
  },
  returns: v.id("bridge_sessions"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const encrypted = await encryptSecret(generateBridgeWebhookSecret());
    return await ctx.db.insert("bridge_sessions", {
      ownerId: args.ownerId,
      provider: args.provider,
      spriteName: args.spriteName,
      mode: args.mode,
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
    consecutiveEmptyWakes: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.authState !== undefined) patch.authState = args.authState;
    if (args.errorMessage !== undefined) patch.errorMessage = args.errorMessage;
    if (args.lastHeartbeatAt !== undefined) patch.lastHeartbeatAt = args.lastHeartbeatAt;
    if (args.lastMessageAtMs !== undefined) patch.lastMessageAtMs = args.lastMessageAtMs;
    if (args.consecutiveEmptyWakes !== undefined) patch.consecutiveEmptyWakes = args.consecutiveEmptyWakes;
    await ctx.db.patch(args.id, patch);
    return null;
  },
});

export const deleteBridgeSession = internalMutation({
  args: { id: v.id("bridge_sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (doc) await ctx.db.delete(args.id);
    return null;
  },
});

export const clearWakeSchedule = internalMutation({
  args: { id: v.id("bridge_sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      nextWakeAtMs: undefined,
      wakeIntervalMs: undefined,
      wakeTier: undefined,
      consecutiveEmptyWakes: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const listDueWakes = internalQuery({
  args: { nowMs: v.number() },
  returns: v.array(decodedBridgeSessionValidator),
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("bridge_sessions")
      .withIndex("by_nextWakeAtMs", (q) => q.lte("nextWakeAtMs", args.nowMs))
      .take(100);
    return await decodeBridgeSessions(
      sessions.filter((s) => s.status === "connected"),
    );
  },
});

export const listAllBridgeSessions = internalQuery({
  args: {},
  returns: v.array(decodedBridgeSessionValidator),
  handler: async (ctx) => {
    const sessions = await ctx.db.query("bridge_sessions").collect();
    return await decodeBridgeSessions(sessions);
  },
});

export const scheduleNextWake = internalMutation({
  args: {
    id: v.id("bridge_sessions"),
    consecutiveEmptyWakes: v.number(),
  },
  returns: v.object({ intervalMs: v.number(), dueAtMs: v.number() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.id);
    if (!session) {
      return {
        intervalMs: 300_000,
        dueAtMs: Date.now() + 300_000,
      };
    }

    const now = Date.now();
    const { intervalMs, tier } = computeWakeInterval(
      session.lastMessageAtMs ?? undefined,
      args.consecutiveEmptyWakes,
      now,
    );
    const dueAtMs = now + intervalMs;

    await ctx.db.patch(args.id, {
      nextWakeAtMs: dueAtMs,
      wakeIntervalMs: intervalMs,
      wakeTier: tier,
      consecutiveEmptyWakes: args.consecutiveEmptyWakes,
      updatedAt: now,
    });

    return { intervalMs, dueAtMs };
  },
});

// ---------------------------------------------------------------------------
// Public Queries (frontend)
// ---------------------------------------------------------------------------

export const getBridgeStatus = query({
  args: { provider: v.string() },
  returns: v.union(v.null(), v.object({
    _id: v.id("bridge_sessions"),
    _creationTime: v.number(),
    ownerId: v.string(),
    provider: v.string(),
    spriteName: v.optional(v.string()),
    mode: v.optional(v.string()),
    status: v.string(),
    authState: bridgeAuthStateValidator,
    errorMessage: v.optional(v.string()),
    lastHeartbeatAt: v.optional(v.number()),
    lastMessageAtMs: v.optional(v.number()),
    nextWakeAtMs: v.optional(v.number()),
    wakeIntervalMs: v.optional(v.number()),
    wakeTier: v.optional(v.string()),
    consecutiveEmptyWakes: v.optional(v.number()),
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
      spriteName: session.spriteName,
      mode: session.mode,
      status: session.status,
      authState: session.authState,
      errorMessage: session.errorMessage,
      lastHeartbeatAt: session.lastHeartbeatAt,
      lastMessageAtMs: session.lastMessageAtMs,
      nextWakeAtMs: session.nextWakeAtMs,
      wakeIntervalMs: session.wakeIntervalMs,
      wakeTier: session.wakeTier,
      consecutiveEmptyWakes: session.consecutiveEmptyWakes,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  },
});

// ---------------------------------------------------------------------------
// Internal Actions — Bridge lifecycle
// ---------------------------------------------------------------------------

export const deployBridge = internalAction({
  args: {
    sessionId: v.id("bridge_sessions"),
    spriteName: v.string(),
    provider: v.string(),
    ownerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const spritesToken = await getSpritesTokenForOwner(ctx, args.ownerId);

      // 1. Create bridge directory
      await spritesExecChecked(
        spritesToken,
        args.spriteName,
        "mkdir -p /home/sprite/stella-bridge",
        "Bridge directory creation",
      );

      // 2. Write bridge service code
      const bridgeCode = getBridgeServiceCode(args.provider);
      const encodedCode = btoa(bridgeCode);
      await spritesExecChecked(
        spritesToken,
        args.spriteName,
        `echo '${encodedCode}' | base64 -d > /home/sprite/stella-bridge/bridge.js`,
        "Bridge code write",
      );

      // 3. Resolve runtime env (do not persist secrets to disk)
      const bridgeSession = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
        ownerId: args.ownerId,
        provider: args.provider,
      });
      if (!bridgeSession) {
        throw new Error(`Missing bridge session for ${args.ownerId}/${args.provider}`);
      }
      const webhookSecret = bridgeSession.webhookSecret;
      if (!webhookSecret) {
        throw new Error("Missing bridge webhook secret");
      }
      const runtimeEnv = buildBridgeRuntimeEnv({
        ownerId: args.ownerId,
        webhookSecret,
      });

      // 4. Install dependencies
      const deps = getBridgeDependencies(args.provider);
      if (deps) {
        await spritesExecChecked(
          spritesToken,
          args.spriteName,
          `cd /home/sprite/stella-bridge && npm install --omit=dev ${deps} 2>&1`,
          "Bridge dependency install",
        );
      }

      // 5. Signal-specific: install signal-cli
      if (args.provider === "signal") {
        // Wait for any existing apt-get to finish, then install Java + signal-cli
        await spritesExecChecked(
          spritesToken,
          args.spriteName,
          `while fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 2; done && ` +
            `if ! command -v java >/dev/null 2>&1; then ` +
            `apt-get update -qq && apt-get install -y -qq openjdk-21-jre-headless > /dev/null 2>&1; fi && ` +
            `if ! command -v signal-cli >/dev/null 2>&1; then ` +
            `cd /tmp && curl -sLO https://github.com/AsamK/signal-cli/releases/download/v0.13.12/signal-cli-0.13.12-Linux.tar.gz && ` +
            `tar xf signal-cli-*.tar.gz && mkdir -p /usr/local/lib/signal-cli && mv signal-cli-*/bin/signal-cli /usr/local/bin/ && ` +
            `mv signal-cli-*/lib /usr/local/lib/signal-cli && rm -rf /tmp/signal-cli*; fi`,
          "Signal runtime install",
        );
      }

      // 6. Start bridge process via exec (nohup + background so it survives the exec session)
      // NOTE: Sprites Services API is broken in rc31 ("service name required" routing bug).
      // Using exec as a workaround until the Services API is fixed.
      await spritesExecChecked(
        spritesToken,
        args.spriteName,
        buildBridgeStartCommand(runtimeEnv),
        "Bridge process start",
      );

      // 7. Update session status
      await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
        id: args.sessionId,
        status: "awaiting_auth",
      });
    } catch (error) {
      console.error(`[bridge] Deploy failed for ${args.provider}:`, error);
      await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
        id: args.sessionId,
        status: "error",
        errorMessage: (error as Error).message,
      });
    }
    return null;
  },
});

export const wakeSprite = internalAction({
  args: {
    sessionId: v.id("bridge_sessions"),
    dueAtMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSessionById, {
      id: args.sessionId,
    });
    if (!session || session.status !== "connected") return null;
    if (args.dueAtMs !== undefined && session.nextWakeAtMs !== args.dueAtMs) return null;
    // wakeSprite is cloud-only; skip if no sprite
    if (!session.spriteName) return null;

    const now = Date.now();

    // Dedup: if heartbeat arrived within 20s, sprite is already awake
    const recentHeartbeat = session.lastHeartbeatAt && now - session.lastHeartbeatAt < 20_000;
    if (!recentHeartbeat) {
      try {
        const spritesToken = await getSpritesTokenForOwner(ctx, session.ownerId);
        await spritesExec(spritesToken, session.spriteName, "echo ok");
        await ctx.runMutation(internal.agent.cloud_devices.touchActivity, {
          ownerId: session.ownerId,
        });
        await setCloudDeviceRunning(ctx, session.ownerId);
      } catch (error) {
        // best-effort: wake is speculative keep-alive; next scheduled wake will retry
        console.error("[bridge] Wake exec failed:", error);
      }
    }

    // Schedule next wake
    const emptyWakes = (session.consecutiveEmptyWakes ?? 0) + 1;
    await scheduleWake(ctx, args.sessionId, emptyWakes);

    return null;
  },
});

export const bridgeWakeTick = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    const sessions = await ctx.runQuery(internal.channels.bridge.listAllBridgeSessions, {});
    const staleThreshold = now - HEARTBEAT_STALE_AFTER_MS;
    for (const session of sessions) {
      if (session.status !== "connected") continue;
      const lastHeartbeatAt = session.lastHeartbeatAt ?? session.updatedAt;
      if (lastHeartbeatAt >= staleThreshold) continue;

      const sessionMode = session.mode ?? "cloud";

      await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
        id: session._id,
        status: "disconnected",
        errorMessage: HEARTBEAT_STALE_REASON,
      });
      await ctx.runMutation(internal.channels.bridge.clearWakeSchedule, { id: session._id });

      if (sessionMode === "cloud") {
        await setCloudDeviceSleepingIfNoActiveBridge(ctx, session.ownerId);
      }
    }

    const due = await ctx.runQuery(internal.channels.bridge.listDueWakes, { nowMs: now });

    for (const session of due) {
      const dueAtMs = session.nextWakeAtMs;
      if (!dueAtMs) continue;

      await ctx.scheduler.runAfter(0, internal.channels.bridge.wakeSprite, {
        sessionId: session._id,
        dueAtMs,
      });
    }

    // Garbage-collect orphaned outbound messages
    await ctx.runMutation(internal.channels.bridge_outbound.gc, {});

    return null;
  },
});

// ---------------------------------------------------------------------------
// Public Actions — Setup/teardown
// ---------------------------------------------------------------------------

export const setupBridge = action({
  args: { provider: v.string() },
  returns: setupBridgeResultValidator,
  handler: async (ctx, args): Promise<SetupBridgeResult> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    if (!(await isOwnerInConnectedMode({ ctx, ownerId }))) {
      throw new Error(CONNECTED_MODE_REQUIRED_ERROR);
    }
    const bridgeMode = "local";

    // Check existing session
    const existing = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId,
      provider: args.provider,
    });
    if (existing) {
      const existingMode = existing.mode ?? "local";
      const shouldReuseExisting =
        existing.status !== "error" &&
        existing.status !== "stopped" &&
        existingMode === bridgeMode;

      if (shouldReuseExisting) {
        return { status: "already_running", sessionId: existing._id };
      }
    }

    // Clean up old session if it exists
    if (existing) {
      await ctx.runMutation(internal.channels.bridge.deleteBridgeSession, { id: existing._id });
    }

    // Local path: create session, no sprite, frontend will deploy via IPC
    const sessionId: Id<"bridge_sessions"> = await ctx.runMutation(
      internal.channels.bridge.createBridgeSession,
      {
        ownerId,
        provider: args.provider,
        mode: "local",
      },
    );

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

    const sessionMode = session.mode ?? "local";

    
    // Local mode: just update status — Electron detects and kills process

    await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
      id: session._id,
      status: "stopped",
    });
    // Clear wake schedule
    await ctx.runMutation(internal.channels.bridge.clearWakeSchedule, { id: session._id });

    if (sessionMode === "cloud") {
      await setCloudDeviceSleepingIfNoActiveBridge(ctx, ownerId);
    }

    return { status: "stopped" };
  },
});

export const getBridgeBundle = action({
  args: { provider: v.string() },
  returns: v.object({ code: v.string(), env: v.record(v.string(), v.string()), dependencies: v.string() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ code: string; env: Record<string, string>; dependencies: string }> => {
    const ownerId = await requireSensitiveUserIdAction(ctx);
    if (!(await isOwnerInConnectedMode({ ctx, ownerId }))) {
      throw new Error(CONNECTED_MODE_REQUIRED_ERROR);
    }
    const session: { webhookSecret: string } | null = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId,
      provider: args.provider,
    });
    if (!session) {
      throw new Error(`No bridge session found for ${args.provider}`);
    }

    const code: string = getBridgeServiceCode(args.provider);
    const env = buildBridgeRuntimeEnv({
      ownerId,
      webhookSecret: session.webhookSecret,
    });
    const dependencies: string = getBridgeDependencies(args.provider);

    return { code, env, dependencies };
  },
});

// ---------------------------------------------------------------------------
// Internal Actions — Webhook handlers (called from HTTP route)
// ---------------------------------------------------------------------------

export const handleHeartbeat = internalAction({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId: args.ownerId,
      provider: args.provider,
    });
    if (!session) return null;

    const sessionMode = session.mode ?? "cloud";

    await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
      id: session._id,
      lastHeartbeatAt: Date.now(),
      ...(session.status === "disconnected" ? { status: "connected" } : {}),
    });

    if (sessionMode === "cloud") {
      await setCloudDeviceRunning(ctx, args.ownerId);

      if (session.status === "disconnected") {
        await scheduleWake(ctx, session._id, 0);
      }
    }
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
  returns: v.null(),
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

    const sessionMode = session.mode ?? "cloud";

    // Auto-create channel_connections when bridge reports connected
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

      if (sessionMode === "cloud") {
        await scheduleWake(ctx, session._id, 0);
      }
    }

    const shouldMarkSleeping = DEVICE_SLEEPING_SESSION_STATUSES.has(args.status);

    if (shouldMarkSleeping) {
      await ctx.runMutation(internal.channels.bridge.clearWakeSchedule, { id: session._id });
    }

    if (sessionMode === "cloud") {
      const shouldMarkRunning = DEVICE_RUNNING_SESSION_STATUSES.has(args.status);
      if (shouldMarkRunning) {
        await setCloudDeviceRunning(ctx, args.ownerId);
      } else if (shouldMarkSleeping) {
        await setCloudDeviceSleepingIfNoActiveBridge(ctx, args.ownerId);
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
  returns: v.null(),
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

    // Look up the bridge session
    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId: args.ownerId,
      provider: args.provider,
    });
    if (!session) {
      console.error(`[bridge] No session found for ${args.provider}/${args.ownerId}`);
      return null;
    }

    // Enqueue reply for bridge.js to poll
    await ctx.runMutation(internal.channels.bridge_outbound.enqueue, {
      sessionId: session._id,
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
      text: result.text,
    });

    // Update message activity and reset empty-wake counter
    await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
      id: session._id,
      lastMessageAtMs: Date.now(),
      consecutiveEmptyWakes: 0,
    });

    if (args.respond === false || !result.text.trim()) {
      return null;
    }

    // Instant promotion: if tier was COOL/COLD/FROZEN, reschedule aggressively (cloud only)
    const sessionMode = session.mode ?? "cloud";
    if (sessionMode === "cloud") {
      const currentTier = session.wakeTier as WakeTierName | undefined;
      if (currentTier && AGGRESSIVE_WAKE_TIERS.has(currentTier)) {
        await scheduleWake(ctx, session._id, 0);
      }
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
  returns: v.null(),
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
    // Clear wake schedule on error
    await ctx.runMutation(internal.channels.bridge.clearWakeSchedule, { id: session._id });
    await setCloudDeviceSleepingIfNoActiveBridge(ctx, args.ownerId);
    return null;
  },
});

