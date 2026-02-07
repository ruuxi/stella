import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { api, internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { requireUserId } from "../auth";
import { processIncomingMessage } from "./utils";
import { spritesApi, spritesApiText, spritesExec, spritesExecChecked } from "../agent/cloud_devices";

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

const bridgeSessionValidator = v.object({
  _id: v.id("bridge_sessions"),
  _creationTime: v.number(),
  ownerId: v.string(),
  provider: v.string(),
  spriteName: v.string(),
  status: v.string(),
  webhookSecret: v.string(),
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
  if (provider === "whatsapp") return "@whiskeysockets/baileys qrcode pino";
  if (provider === "signal") return ""; // signal-cli is a standalone binary
  return "";
}

function generateBridgeWebhookSecret(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const randomHex = (byteLength: number) => {
      const bytes = new Uint8Array(byteLength);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    return `${randomHex(16)}-${randomHex(16)}-${randomHex(16)}-${randomHex(16)}`;
  }

  throw new Error("Secure random generator unavailable for bridge webhook secret");
}

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

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

export const getBridgeSession = internalQuery({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  returns: v.union(bridgeSessionValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bridge_sessions")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .first();
  },
});

export const getBridgeSessionById = internalQuery({
  args: { id: v.id("bridge_sessions") },
  returns: v.union(bridgeSessionValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const hasActiveBridgeForOwner = internalQuery({
  args: { ownerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const sessions = await ctx.db.query("bridge_sessions").collect();
    return sessions.some(
      (session) =>
        session.ownerId === args.ownerId &&
        (session.status === "connected" ||
          session.status === "awaiting_auth" ||
          session.status === "initializing"),
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
    spriteName: v.string(),
  },
  returns: v.id("bridge_sessions"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("bridge_sessions", {
      ownerId: args.ownerId,
      provider: args.provider,
      spriteName: args.spriteName,
      status: "initializing",
      webhookSecret: generateBridgeWebhookSecret(),
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
  returns: v.array(bridgeSessionValidator),
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("bridge_sessions")
      .withIndex("by_next_wake", (q) => q.lte("nextWakeAtMs", args.nowMs))
      .take(100);
    return sessions.filter((s) => s.status === "connected");
  },
});

export const listAllBridgeSessions = internalQuery({
  args: {},
  returns: v.array(bridgeSessionValidator),
  handler: async (ctx) => {
    return await ctx.db.query("bridge_sessions").collect();
  },
});

export const scheduleNextWake = internalMutation({
  args: {
    id: v.id("bridge_sessions"),
    consecutiveEmptyWakes: v.number(),
  },
  returns: v.object({
    intervalMs: v.number(),
    dueAtMs: v.number(),
  }),
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
  returns: v.union(bridgeSessionValidator, v.null()),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("bridge_sessions")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", identity.subject).eq("provider", args.provider),
      )
      .first();
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
      // 1. Create bridge directory
      await spritesExecChecked(
        args.spriteName,
        "mkdir -p /home/sprite/stella-bridge",
        "Bridge directory creation",
      );

      // 2. Write bridge service code
      const bridgeCode = getBridgeServiceCode(args.provider);
      const encodedCode = btoa(bridgeCode);
      await spritesExecChecked(
        args.spriteName,
        `echo '${encodedCode}' | base64 -d > /home/sprite/stella-bridge/bridge.js`,
        "Bridge code write",
      );

      // 3. Write config
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

      const config = {
        provider: args.provider,
        webhookUrl: `${process.env.CONVEX_SITE_URL}/api/webhooks/bridge`,
        webhookSecret,
        ownerId: args.ownerId,
      };
      const encodedConfig = btoa(JSON.stringify(config));
      await spritesExecChecked(
        args.spriteName,
        `echo '${encodedConfig}' | base64 -d > /home/sprite/stella-bridge/config.json`,
        "Bridge config write",
      );

      // 4. Install dependencies
      const deps = getBridgeDependencies(args.provider);
      if (deps) {
        await spritesExecChecked(
          args.spriteName,
          `cd /home/sprite/stella-bridge && npm install ${deps} 2>&1`,
          "Bridge dependency install",
        );
      }

      // 5. Signal-specific: install signal-cli
      if (args.provider === "signal") {
        // Wait for any existing apt-get to finish, then install Java + signal-cli
        await spritesExecChecked(
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
        args.spriteName,
        `cd /home/sprite/stella-bridge && nohup node bridge.js > bridge.log 2>&1 &`,
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

    const now = Date.now();

    // Dedup: if heartbeat arrived within 20s, sprite is already awake
    const recentHeartbeat = session.lastHeartbeatAt && now - session.lastHeartbeatAt < 20_000;
    if (!recentHeartbeat) {
      try {
        await spritesExec(session.spriteName, "echo ok");
        await ctx.runMutation(internal.agent.cloud_devices.touchActivity, {
          ownerId: session.ownerId,
        });
        const device = await ctx.runQuery(internal.agent.cloud_devices.getForOwner, {
          ownerId: session.ownerId,
        });
        if (device && device.status !== "running" && device.status !== "error") {
          await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
            id: device._id,
            status: "running",
          });
        }
      } catch (error) {
        console.error("[bridge] Wake exec failed:", error);
      }
    }

    // Schedule next wake
    const emptyWakes = (session.consecutiveEmptyWakes ?? 0) + 1;
    const nextWake = await ctx.runMutation(internal.channels.bridge.scheduleNextWake, {
      id: args.sessionId,
      consecutiveEmptyWakes: emptyWakes,
    });

    await ctx.scheduler.runAfter(nextWake.intervalMs, internal.channels.bridge.wakeSprite, {
      sessionId: args.sessionId,
      dueAtMs: nextWake.dueAtMs,
    });

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

      await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
        id: session._id,
        status: "disconnected",
        errorMessage: HEARTBEAT_STALE_REASON,
      });
      await ctx.runMutation(internal.channels.bridge.clearWakeSchedule, { id: session._id });

      const hasActiveBridge = await ctx.runQuery(internal.channels.bridge.hasActiveBridgeForOwner, {
        ownerId: session.ownerId,
      });
      if (!hasActiveBridge) {
        const device = await ctx.runQuery(internal.agent.cloud_devices.getForOwner, {
          ownerId: session.ownerId,
        });
        if (device && device.status !== "sleeping" && device.status !== "error") {
          await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
            id: device._id,
            status: "sleeping",
          });
        }
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
    const ownerId = await requireUserId(ctx);
    const runtimeMode = await ctx.runQuery(internal.data.preferences.getRuntimeModeForOwner, {
      ownerId,
    });
    if (runtimeMode !== "cloud_247") {
      throw new Error(
        "24/7 mode is disabled. Enable 24/7 in Settings before connecting WhatsApp or Signal.",
      );
    }

    // Check existing session
    const existing = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId,
      provider: args.provider,
    });
    if (existing && existing.status !== "error" && existing.status !== "stopped") {
      return { status: "already_running", sessionId: existing._id };
    }

    // Clean up old session if it exists
    if (existing) {
      await ctx.runMutation(internal.channels.bridge.deleteBridgeSession, { id: existing._id });
    }

    // Ensure user has a sprite
    let spriteName: string | null = await ctx.runQuery(
      internal.agent.cloud_devices.resolveForOwner,
      { ownerId },
    );
    if (!spriteName) {
      // Auto-provision a sprite (enable247 is a public action)
      const result = await ctx.runAction(api.agent.cloud_devices.enable247, {});
      spriteName = result.spriteName;
    }

    // Create session record
    const sessionId: Id<"bridge_sessions"> = await ctx.runMutation(
      internal.channels.bridge.createBridgeSession,
      {
        ownerId,
        provider: args.provider,
        spriteName,
      },
    );

    // Deploy bridge code
    await ctx.scheduler.runAfter(0, internal.channels.bridge.deployBridge, {
      sessionId,
      spriteName,
      provider: args.provider,
      ownerId,
    });

    return { status: "initializing", sessionId };
  },
});

export const stopBridge = action({
  args: { provider: v.string() },
  returns: stopBridgeResultValidator,
  handler: async (ctx, args): Promise<StopBridgeResult> => {
    const ownerId = await requireUserId(ctx);
    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId,
      provider: args.provider,
    });
    if (!session) return { status: "not_running" };

    // Kill the bridge process
    try {
      await spritesExecChecked(
        session.spriteName,
        `pkill -f 'node.*bridge.js' || true`,
        "Bridge process stop",
      );
    } catch {
      // May already be stopped
    }

    await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
      id: session._id,
      status: "stopped",
    });
    // Clear wake schedule
    await ctx.runMutation(internal.channels.bridge.clearWakeSchedule, { id: session._id });
    const hasActiveBridge = await ctx.runQuery(internal.channels.bridge.hasActiveBridgeForOwner, {
      ownerId,
    });
    if (!hasActiveBridge) {
      const device = await ctx.runQuery(internal.agent.cloud_devices.getForOwner, {
        ownerId,
      });
      if (device && device.status !== "sleeping" && device.status !== "error") {
        await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
          id: device._id,
          status: "sleeping",
        });
      }
    }

    return { status: "stopped" };
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

    await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
      id: session._id,
      lastHeartbeatAt: Date.now(),
      ...(session.status === "disconnected" ? { status: "connected" } : {}),
    });

    const device = await ctx.runQuery(internal.agent.cloud_devices.getForOwner, {
      ownerId: args.ownerId,
    });
    if (device && device.status !== "running" && device.status !== "error") {
      await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
        id: device._id,
        status: "running",
      });
    }

    if (session.status === "disconnected") {
      const nextWake = await ctx.runMutation(internal.channels.bridge.scheduleNextWake, {
        id: session._id,
        consecutiveEmptyWakes: 0,
      });
      await ctx.scheduler.runAfter(nextWake.intervalMs, internal.channels.bridge.wakeSprite, {
        sessionId: session._id,
        dueAtMs: nextWake.dueAtMs,
      });
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

    // Auto-create channel_connections when bridge reports connected
    if (args.status === "connected") {
      const externalId =
        (args.authState as Record<string, string>)?.phoneNumber ??
        (args.authState as Record<string, string>)?.externalUserId ??
        "";

      if (externalId) {
        const existing = await ctx.runQuery(
          internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
          {
            ownerId: args.ownerId,
            provider: args.provider,
            externalUserId: externalId,
          },
        );
        if (!existing) {
          await ctx.runMutation(internal.channels.utils.createConnection, {
            ownerId: args.ownerId,
            provider: args.provider,
            externalUserId: externalId,
            displayName:
              (args.authState as Record<string, string>)?.displayName,
          });
        }
      }

      const nextWake = await ctx.runMutation(internal.channels.bridge.scheduleNextWake, {
        id: session._id,
        consecutiveEmptyWakes: 0,
      });
      await ctx.scheduler.runAfter(nextWake.intervalMs, internal.channels.bridge.wakeSprite, {
        sessionId: session._id,
        dueAtMs: nextWake.dueAtMs,
      });
    }

    const shouldMarkRunning =
      args.status === "connected" ||
      args.status === "awaiting_auth" ||
      args.status === "initializing";
    const shouldMarkSleeping =
      args.status === "error" ||
      args.status === "disconnected" ||
      args.status === "stopped" ||
      args.status === "logged_out";

    if (shouldMarkSleeping) {
      await ctx.runMutation(internal.channels.bridge.clearWakeSchedule, { id: session._id });
    }

    const device = await ctx.runQuery(internal.agent.cloud_devices.getForOwner, {
      ownerId: args.ownerId,
    });
    if (device && device.status !== "error") {
      if (shouldMarkRunning && device.status !== "running") {
        await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
          id: device._id,
          status: "running",
        });
      } else if (shouldMarkSleeping && device.status !== "sleeping") {
        const hasActiveBridge = await ctx.runQuery(internal.channels.bridge.hasActiveBridgeForOwner, {
          ownerId: args.ownerId,
        });
        if (!hasActiveBridge) {
          await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
            id: device._id,
            status: "sleeping",
          });
        }
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!args.externalUserId || !args.text.trim()) return null;

    // Bridge providers receive sender IDs that are not pre-linked via code.
    // Ensure owner-scoped routing exists for this sender before processing.
    const existing = await ctx.runQuery(
      internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
      {
        ownerId: args.ownerId,
        provider: args.provider,
        externalUserId: args.externalUserId,
      },
    );
    if (!existing) {
      await ctx.runMutation(internal.channels.utils.createConnection, {
        ownerId: args.ownerId,
        provider: args.provider,
        externalUserId: args.externalUserId,
        displayName: args.displayName,
      });
    }

    const result = await processIncomingMessage({
      ctx,
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
      text: args.text,
    });

    if (!result) return null;

    // Look up the bridge session to get the sprite name
    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId: args.ownerId,
      provider: args.provider,
    });
    if (!session) {
      console.error(`[bridge] No session found for ${args.provider}/${args.ownerId}`);
      return null;
    }

    // Deliver reply by executing curl inside the sprite to hit the bridge's
    // local HTTP server. This avoids the sprite's internal hostname being
    // unreachable from Convex's network.
    const payload = JSON.stringify({
      externalUserId: args.externalUserId,
      text: result.text,
    });
    const escapedPayload = payload.replace(/'/g, "'\\''");
    let deliveryError: unknown = null;
    let delivered = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await spritesExecChecked(
          session.spriteName,
          `curl -fsS -X POST http://localhost:8080/reply -H 'Content-Type: application/json' -d '${escapedPayload}'`,
          `${args.provider} reply delivery (attempt ${attempt}/3)`,
        );
        delivered = true;
        break;
      } catch (error) {
        deliveryError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
    if (!delivered) {
      console.error(`[bridge] Failed to deliver reply for ${args.provider}:`, deliveryError);
    }

    // Update message activity and reset empty-wake counter
    await ctx.runMutation(internal.channels.bridge.updateBridgeSession, {
      id: session._id,
      lastMessageAtMs: Date.now(),
      consecutiveEmptyWakes: 0,
    });

    // Instant promotion: if tier was COOL/COLD/FROZEN, reschedule aggressively
    const currentTier = session.wakeTier;
    if (currentTier === "COOL" || currentTier === "COLD" || currentTier === "FROZEN") {
      const nextWake = await ctx.runMutation(internal.channels.bridge.scheduleNextWake, {
        id: session._id,
        consecutiveEmptyWakes: 0,
      });
      await ctx.scheduler.runAfter(nextWake.intervalMs, internal.channels.bridge.wakeSprite, {
        sessionId: session._id,
        dueAtMs: nextWake.dueAtMs,
      });
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
    const hasActiveBridge = await ctx.runQuery(internal.channels.bridge.hasActiveBridgeForOwner, {
      ownerId: args.ownerId,
    });
    if (!hasActiveBridge) {
      const device = await ctx.runQuery(internal.agent.cloud_devices.getForOwner, {
        ownerId: args.ownerId,
      });
      if (device && device.status !== "sleeping" && device.status !== "error") {
        await ctx.runMutation(internal.agent.cloud_devices.updateStatus, {
          id: device._id,
          status: "sleeping",
        });
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Bridge Service Code — WhatsApp (Baileys)
// ---------------------------------------------------------------------------

const WHATSAPP_BRIDGE_CODE = `
const http = require("http");
const config = require("./config.json");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");

const logger = pino({ level: "silent" });
let sock = null;

async function postWebhook(body) {
  try {
    await fetch(config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-secret": config.webhookSecret,
      },
      body: JSON.stringify({ ...body, provider: "whatsapp", ownerId: config.ownerId }),
    });
  } catch (err) {
    console.error("[bridge] Webhook POST failed:", err.message);
  }
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("/home/sprite/stella-bridge/auth_state");

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
      await postWebhook({
        type: "auth_update",
        status: "awaiting_auth",
        authState: { qrCode: qrDataUrl, generatedAt: Date.now() },
      });
    }

    if (connection === "open") {
      const phoneNumber = sock.user?.id?.split(":")[0] || "";
      await postWebhook({
        type: "auth_update",
        status: "connected",
        authState: { phoneNumber, externalUserId: phoneNumber },
      });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => startWhatsApp(), 3000);
      } else {
        await postWebhook({
          type: "error",
          error: "WhatsApp logged out. Please re-scan QR code.",
        });
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const message = msg.message || {};
      const text =
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        (message.imageMessage ? "[Image message]" : "") ||
        (message.videoMessage ? "[Video message]" : "") ||
        (message.documentMessage ? "[Document message]" : "") ||
        (message.audioMessage ? "[Audio message]" : "");
      if (!text) continue;

      const from = msg.key.remoteJid;
      const pushName = msg.pushName || "";

      const spriteHost = process.env.HOSTNAME || "localhost";
      await postWebhook({
        type: "message",
        externalUserId: from,
        text,
        displayName: pushName,
        replyCallback: \`http://\${spriteHost}:8080/reply\`,
      });
    }
  });
}

// HTTP server for receiving replies from Convex
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/reply") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (sock && data.externalUserId && data.text) {
          await sock.sendMessage(data.externalUserId, { text: data.text });
        }
        res.writeHead(200);
        res.end("OK");
      } catch (err) {
        console.error("[bridge] Reply handler error:", err.message);
        res.writeHead(500);
        res.end("Error");
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8080, () => console.log("[bridge] WhatsApp bridge listening on :8080"));

// Heartbeat
setInterval(() => postWebhook({ type: "heartbeat" }), 60000);

// Start
startWhatsApp().catch((err) => {
  console.error("[bridge] WhatsApp startup failed:", err);
  postWebhook({ type: "error", error: err.message });
});
`.trim();

// ---------------------------------------------------------------------------
// Bridge Service Code — Signal (signal-cli)
// ---------------------------------------------------------------------------

const SIGNAL_BRIDGE_CODE = `
const http = require("http");
const { spawn } = require("child_process");
const config = require("./config.json");

let signalProcess = null;

async function postWebhook(body) {
  try {
    await fetch(config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-secret": config.webhookSecret,
      },
      body: JSON.stringify({ ...body, provider: "signal", ownerId: config.ownerId }),
    });
  } catch (err) {
    console.error("[bridge] Webhook POST failed:", err.message);
  }
}

const SIGNAL_DATA = "/home/sprite/stella-bridge/signal-data";
const SIGNAL_RPC_URL = "http://127.0.0.1:8081/api/v1/rpc";

async function linkSignal() {
  return new Promise((resolve, reject) => {
    const proc = spawn("signal-cli", [
      "--config", SIGNAL_DATA,
      "link", "--name", "Stella AI",
    ]);

    let linkUri = "";

    proc.stdout.on("data", (data) => {
      const line = data.toString().trim();
      const match = line.match(/tsdevice:[^\\s]+/);
      if (match) {
        linkUri = match[0];
        postWebhook({
          type: "auth_update",
          status: "awaiting_auth",
          authState: { linkUri, generatedAt: Date.now() },
        });
      }
    });

    proc.stderr.on("data", (data) => {
      console.error("[signal-cli link]", data.toString());
    });

    proc.on("close", (code) => {
      if (code === 0 && linkUri) {
        resolve(linkUri);
      } else {
        reject(new Error("signal-cli link failed with code " + code));
      }
    });
  });
}

function extractAccountId(output) {
  const lines = output
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const phone = line.match(/\\+\\d{6,15}/);
    if (phone) return phone[0];

    const uuid = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuid) return \`uuid:\${uuid[0]}\`;

    if (!line.includes(" ")) return line;
  }

  return "";
}

async function getLinkedAccountId() {
  return new Promise((resolve) => {
    const proc = spawn("signal-cli", [
      "--config", SIGNAL_DATA,
      "listAccounts",
    ]);

    let out = "";
    proc.stdout.on("data", (data) => {
      out += data.toString();
    });

    proc.on("error", () => resolve(""));
    proc.on("close", () => resolve(extractAccountId(out)));
  });
}

async function reportConnectedAndStart() {
  const externalUserId = await getLinkedAccountId();
  const authState = externalUserId
    ? { externalUserId, phoneNumber: externalUserId }
    : {};

  await postWebhook({
    type: "auth_update",
    status: "connected",
    authState,
  });
  startDaemon();
}

function startDaemon() {
  signalProcess = spawn("signal-cli", [
    "--config", SIGNAL_DATA,
    "daemon", "--json",
    "--http", "127.0.0.1:8081",
  ]);

  let buffer = "";
  signalProcess.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.envelope?.dataMessage?.message) {
          const from = msg.envelope.source || "";
          const text = msg.envelope.dataMessage.message;
          const displayName = msg.envelope.sourceName || "";

          const spriteHost = process.env.HOSTNAME || "localhost";
          postWebhook({
            type: "message",
            externalUserId: from,
            text,
            displayName,
            replyCallback: \`http://\${spriteHost}:8080/reply\`,
          });
        }
      } catch {}
    }
  });

  signalProcess.stderr.on("data", (data) => {
    console.error("[signal-cli daemon]", data.toString());
  });

  signalProcess.on("close", (code) => {
    console.error("[signal-cli daemon] Exited with code", code);
    postWebhook({ type: "error", error: "signal-cli daemon exited with code " + code });
  });
}

async function sendSignalMessage(recipient, message) {
  const res = await fetch(SIGNAL_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "send",
      params: {
        recipient: [recipient],
        message,
      },
      id: Date.now(),
    }),
  });

  if (!res.ok) {
    throw new Error(\`Signal RPC send failed: HTTP \${res.status}\`);
  }

  const payload = await res.json().catch(() => null);
  if (payload?.error) {
    throw new Error(payload.error?.message || "Signal RPC send failed");
  }
}

// HTTP server for receiving replies from Convex
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/reply") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (data.externalUserId && data.text) {
          await sendSignalMessage(data.externalUserId, data.text);
        }
        res.writeHead(200);
        res.end("OK");
      } catch (err) {
        console.error("[bridge] Reply handler error:", err.message);
        res.writeHead(500);
        res.end("Error");
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8080, () => console.log("[bridge] Signal bridge listening on :8080"));

// Heartbeat
setInterval(() => postWebhook({ type: "heartbeat" }), 60000);

async function bootstrapSignal() {
  const existingAccount = await getLinkedAccountId();
  if (existingAccount) {
    console.log("[bridge] Signal already linked, starting daemon...");
    await reportConnectedAndStart();
    return;
  }

  console.log("[bridge] Signal not linked, starting link flow...");
  await linkSignal();
  console.log("[bridge] Signal linked successfully, starting daemon...");
  await reportConnectedAndStart();
}

bootstrapSignal().catch((err) => {
  console.error("[bridge] Signal startup failed:", err);
  postWebhook({ type: "error", error: err.message });
});
`.trim();
