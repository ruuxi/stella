import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireUserId } from "./auth";
import { processIncomingMessage } from "./channel_utils";
import { spritesApi, spritesApiText, spritesExecChecked } from "./cloud_devices";

// ---------------------------------------------------------------------------
// Bridge service code templates
// ---------------------------------------------------------------------------

function getBridgeServiceCode(provider: string): string {
  if (provider === "whatsapp") return WHATSAPP_BRIDGE_CODE;
  if (provider === "signal") return SIGNAL_BRIDGE_CODE;
  throw new Error(`Unknown bridge provider: ${provider}`);
}

function getBridgeDependencies(provider: string): string {
  if (provider === "whatsapp") return "@whiskeysockets/baileys qrcode-terminal pino";
  if (provider === "signal") return ""; // signal-cli is a standalone binary
  return "";
}

function generateBridgeWebhookSecret(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Internal Queries
// ---------------------------------------------------------------------------

export const getBridgeSession = internalQuery({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bridge_sessions")
      .withIndex("by_owner_provider", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .first();
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
    authState: v.optional(v.any()),
    errorMessage: v.optional(v.string()),
    lastHeartbeatAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.authState !== undefined) patch.authState = args.authState;
    if (args.errorMessage !== undefined) patch.errorMessage = args.errorMessage;
    if (args.lastHeartbeatAt !== undefined) patch.lastHeartbeatAt = args.lastHeartbeatAt;
    await ctx.db.patch(args.id, patch);
  },
});

export const deleteBridgeSession = internalMutation({
  args: { id: v.id("bridge_sessions") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

// ---------------------------------------------------------------------------
// Public Queries (frontend)
// ---------------------------------------------------------------------------

export const getBridgeStatus = query({
  args: { provider: v.string() },
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
      const encodedCode = Buffer.from(bridgeCode).toString("base64");
      await spritesExecChecked(
        args.spriteName,
        `echo '${encodedCode}' | base64 -d > /home/sprite/stella-bridge/bridge.js`,
        "Bridge code write",
      );

      // 3. Write config
      const bridgeSession = await ctx.runQuery(internal.bridge.getBridgeSession, {
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
      const encodedConfig = Buffer.from(JSON.stringify(config)).toString("base64");
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
        await spritesExecChecked(
          args.spriteName,
          `if ! command -v java >/dev/null 2>&1 || ! command -v signal-cli >/dev/null 2>&1; then ` +
            `apt-get update -qq && apt-get install -y -qq curl openjdk-21-jre-headless > /dev/null 2>&1; fi && ` +
            `if ! command -v signal-cli >/dev/null 2>&1; then ` +
            `cd /tmp && curl -sLO https://github.com/AsamK/signal-cli/releases/download/v0.13.12/signal-cli-0.13.12-Linux.tar.gz && ` +
            `tar xf signal-cli-*.tar.gz && mkdir -p /usr/local/lib/signal-cli && mv signal-cli-*/bin/signal-cli /usr/local/bin/ && ` +
            `mv signal-cli-*/lib /usr/local/lib/signal-cli && rm -rf /tmp/signal-cli*; fi`,
          "Signal runtime install",
        );
      }

      // 6. Start as Sprites Service (auto-restarts on crash)
      // PUT creates AND starts the service (response: service object with "starting" status)
      // Fields per Sprites docs: cmd (string), args (string[]), needs (string[]), http_port (number?)
      const serviceName = `stella-bridge-${args.provider}`;
      await spritesApi(
        `/sprites/${args.spriteName}/services/${serviceName}`,
        "PUT",
        {
          cmd: "node",
          args: ["/home/sprite/stella-bridge/bridge.js"],
          needs: [],
          http_port: 8080,
        },
      );

      // 7. Update session status
      await ctx.runMutation(internal.bridge.updateBridgeSession, {
        id: args.sessionId,
        status: "awaiting_auth",
      });
    } catch (error) {
      console.error(`[bridge] Deploy failed for ${args.provider}:`, error);
      await ctx.runMutation(internal.bridge.updateBridgeSession, {
        id: args.sessionId,
        status: "error",
        errorMessage: (error as Error).message,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Public Actions — Setup/teardown
// ---------------------------------------------------------------------------

export const setupBridge = action({
  args: { provider: v.string() },
  handler: async (ctx, args): Promise<{ status: string; sessionId?: Id<"bridge_sessions"> }> => {
    const ownerId = await requireUserId(ctx);

    // Check existing session
    const existing = await ctx.runQuery(internal.bridge.getBridgeSession, {
      ownerId,
      provider: args.provider,
    });
    if (existing && existing.status !== "error" && existing.status !== "stopped") {
      return { status: "already_running", sessionId: existing._id };
    }

    // Clean up old session if it exists
    if (existing) {
      await ctx.runMutation(internal.bridge.deleteBridgeSession, { id: existing._id });
    }

    // Ensure user has a sprite
    let spriteName: string | null = await ctx.runQuery(
      internal.cloud_devices.resolveForOwner,
      { ownerId },
    );
    if (!spriteName) {
      // Auto-provision a sprite (enable247 is a public action)
      const result = await ctx.runAction(api.cloud_devices.enable247, {});
      spriteName = result.spriteName;
    }

    // Create session record
    const sessionId: Id<"bridge_sessions"> = await ctx.runMutation(
      internal.bridge.createBridgeSession,
      {
        ownerId,
        provider: args.provider,
        spriteName,
      },
    );

    // Deploy bridge code
    await ctx.scheduler.runAfter(0, internal.bridge.deployBridge, {
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
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const session = await ctx.runQuery(internal.bridge.getBridgeSession, {
      ownerId,
      provider: args.provider,
    });
    if (!session) return { status: "not_running" };

    // Stop the Sprites Service (returns streaming NDJSON)
    const serviceName = `stella-bridge-${args.provider}`;
    try {
      await spritesApiText(
        `/sprites/${session.spriteName}/services/${serviceName}/stop`,
        "POST",
      );
    } catch {
      // May already be stopped
    }

    await ctx.runMutation(internal.bridge.updateBridgeSession, {
      id: session._id,
      status: "stopped",
    });

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
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.bridge.getBridgeSession, {
      ownerId: args.ownerId,
      provider: args.provider,
    });
    if (!session) return;

    await ctx.runMutation(internal.bridge.updateBridgeSession, {
      id: session._id,
      lastHeartbeatAt: Date.now(),
    });
  },
});

export const handleAuthUpdate = internalAction({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    authState: v.any(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.bridge.getBridgeSession, {
      ownerId: args.ownerId,
      provider: args.provider,
    });
    if (!session) return;

    await ctx.runMutation(internal.bridge.updateBridgeSession, {
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
          internal.channel_utils.getConnectionByOwnerProviderAndExternalId,
          {
            ownerId: args.ownerId,
            provider: args.provider,
            externalUserId: externalId,
          },
        );
        if (!existing) {
          await ctx.runMutation(internal.channel_utils.createConnection, {
            ownerId: args.ownerId,
            provider: args.provider,
            externalUserId: externalId,
            displayName:
              (args.authState as Record<string, string>)?.displayName,
          });
        }
      }
    }
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
  handler: async (ctx, args) => {
    if (!args.externalUserId || !args.text.trim()) return;

    // Bridge providers receive sender IDs that are not pre-linked via code.
    // Ensure owner-scoped routing exists for this sender before processing.
    const existing = await ctx.runQuery(
      internal.channel_utils.getConnectionByOwnerProviderAndExternalId,
      {
        ownerId: args.ownerId,
        provider: args.provider,
        externalUserId: args.externalUserId,
      },
    );
    if (!existing) {
      await ctx.runMutation(internal.channel_utils.createConnection, {
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

    if (!result) return;

    // Look up the bridge session to get the sprite name
    const session = await ctx.runQuery(internal.bridge.getBridgeSession, {
      ownerId: args.ownerId,
      provider: args.provider,
    });
    if (!session) {
      console.error(`[bridge] No session found for ${args.provider}/${args.ownerId}`);
      return;
    }

    // Deliver reply by executing curl inside the sprite to hit the bridge's
    // local HTTP server. This avoids the sprite's internal hostname being
    // unreachable from Convex's network.
    try {
      const payload = JSON.stringify({
        externalUserId: args.externalUserId,
        text: result.text,
      });
      const escapedPayload = payload.replace(/'/g, "'\\''");
      await spritesExecChecked(
        session.spriteName,
        `curl -fsS -X POST http://localhost:8080/reply -H 'Content-Type: application/json' -d '${escapedPayload}'`,
        `${args.provider} reply delivery`,
      );
    } catch (error) {
      console.error(`[bridge] Failed to deliver reply for ${args.provider}:`, error);
    }
  },
});

export const handleBridgeError = internalAction({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.bridge.getBridgeSession, {
      ownerId: args.ownerId,
      provider: args.provider,
    });
    if (!session) return;

    console.error(`[bridge] Error from ${args.provider} bridge:`, args.error);
    await ctx.runMutation(internal.bridge.updateBridgeSession, {
      id: session._id,
      status: "error",
      errorMessage: args.error,
    });
  },
});

// ---------------------------------------------------------------------------
// Bridge Service Code — WhatsApp (Baileys)
// ---------------------------------------------------------------------------

const WHATSAPP_BRIDGE_CODE = `
const http = require("http");
const config = require("./config.json");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
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
      await postWebhook({
        type: "auth_update",
        status: "awaiting_auth",
        authState: { qrCode: qr, generatedAt: Date.now() },
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
