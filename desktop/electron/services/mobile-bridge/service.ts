import crypto from "crypto";
import fs from "fs";
import http, { type IncomingMessage, type ServerResponse } from "http";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  isMobileBridgeEventChannel,
  isMobileBridgeRequestChannel,
} from "./bridge-policy.js";
import type { MobileBridgeBootstrap } from "./bootstrap-payload.js";
import {
  BRIDGE_CRYPTO_PROTOCOL,
  createBridgeKeyPair,
  decryptBridgePayload,
  deriveBridgeCryptoSession,
  encryptBridgePayload,
  isBridgeEncryptedEnvelope,
  type BridgeCryptoSession,
} from "./crypto.js";
import { getHandler, getOnHandlers } from "./handler-registry.js";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

const REGISTRATION_REFRESH_MS = 60_000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const CHALLENGE_TTL_MS = 60_000;
const COOKIE_NAME = "stella_mobile_bridge";
const MAX_BODY_SIZE = 5 * 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const ALLOW_METHODS = "GET, POST, OPTIONS";
const ALLOW_HEADERS =
  "Content-Type, X-Stella-Bridge-Session-Id, X-Stella-Bridge-Session-Secret, X-Stella-Bridge-Challenge-Id, X-Stella-Bridge-Encrypted";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const MOBILE_BRIDGE_SENDER_URL = "stella-mobile-bridge://mobile";
const DEVELOPER_RESOURCE_PREVIEWS_KEY = "stella-developer-resource-previews";
/** Per-tick probe budget when re-checking the advertised public tunnel URL. */
const BRIDGE_PUBLIC_HEALTH_TIMEOUT_MS = 2_000;
/**
 * Consecutive failed health probes (across refresh/sync ticks) before we treat
 * the advertised tunnel as dead and clear availability. A small streak avoids
 * down-registering on a single transient blip while still reacting well within
 * the 150s registration lease.
 */
const BRIDGE_PUBLIC_HEALTH_FAILURE_THRESHOLD = 3;
/**
 * Reuse a successful probe for this long. Coalesced/burst syncs fire within
 * milliseconds, so this collapses their duplicate probe; the real refresh ticks
 * (30s setters / 60s timer) are spaced well beyond it and always re-probe.
 */
const BRIDGE_PUBLIC_HEALTH_CACHE_MS = 3_000;

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

type MobileBridgeServiceOptions = {
  electronDir: string;
  isDev: boolean;
  getDevServerUrl: () => string;
  onClientActivity?: () => void;
};

type BridgeSessionRecord = {
  expiresAt: number;
  crypto?: BridgeCryptoSession;
  mobileDeviceId?: string;
  sessionSecret?: string;
};

type BridgeChallengeRecord = {
  challenge: string;
  expiresAt: number;
};

type BridgeRegistrationState =
  | "inactive"
  | "healthy"
  | "degraded"
  | "expired"
  | "revoked";

export type MobileBroadcastFn = (channel: string, data: unknown) => void;
type CapturedIpcDispatchResult =
  | { kind: "handle"; result: unknown }
  | { kind: "event" };

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const parseCookies = (cookieHeader?: string | null) =>
  Object.fromEntries(
    (cookieHeader ?? "")
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [key, ...rest] = entry.split("=");
        return [key, rest.join("=")];
      }),
  );

const getDesktopPlatformLabel = () => {
  if (process.platform === "darwin") {
    return "Mac";
  }
  if (process.platform === "win32") {
    return "Windows";
  }
  return os.type();
};

const dispatchCapturedIpc = async (
  channel: string,
  args: unknown,
  broadcastToMobile: MobileBroadcastFn,
  options?: { swallowEventHandlerErrors?: boolean },
): Promise<CapturedIpcDispatchResult> => {
  const handleHandler = getHandler(channel);
  const onHandlerList = !handleHandler ? getOnHandlers(channel) : undefined;

  if (!handleHandler && (!onHandlerList || onHandlerList.length === 0)) {
    throw new Error(`Unknown IPC channel: ${channel}`);
  }

  const fakeEvent = createFakeIpcEvent(broadcastToMobile);
  const spreadArgs = Array.isArray(args) ? args : [args];

  if (handleHandler) {
    return {
      kind: "handle",
      result: await handleHandler(fakeEvent, ...spreadArgs),
    };
  }

  for (const handler of onHandlerList!) {
    try {
      handler(fakeEvent as unknown as IpcMainEvent, ...spreadArgs);
    } catch (error) {
      if (!options?.swallowEventHandlerErrors) {
        throw error;
      }
      console.warn(
        `[mobile-bridge] on-handler error for ${channel}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { kind: "event" };
};

const readBody = (req: IncomingMessage): Promise<string> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Body read timeout"));
        req.destroy();
      }
    }, BODY_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("Body too large"));
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
};

const getCorsHeaders = (origin?: string | null) =>
  origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
      }
    : {};

const sendJson = (
  res: ServerResponse,
  status: number,
  data: unknown,
  origin?: string | null,
) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...getCorsHeaders(origin),
    ...NO_STORE_HEADERS,
  });
  res.end(body);
};

const sendNoContent = (res: ServerResponse, origin?: string | null) => {
  res.writeHead(204, {
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    ...getCorsHeaders(origin),
    ...NO_STORE_HEADERS,
  });
  res.end();
};

/**
 * Fake IPC event for bridging. The dedicated sender URL lets privileged
 * handlers recognize mobile bridge requests, and sender.send() routes
 * replies back to subscribed mobile WebSocket clients.
 */
const createFakeIpcEvent = (
  broadcastFn: MobileBroadcastFn,
): IpcMainInvokeEvent & IpcMainEvent => {
  return {
    sender: {
      id: -1,
      send: (channel: string, ...args: unknown[]) => {
        broadcastFn(channel, args.length === 1 ? args[0] : args);
      },
      getURL: () => MOBILE_BRIDGE_SENDER_URL,
      isDestroyed: () => false,
    },
    senderFrame: { url: MOBILE_BRIDGE_SENDER_URL },
    processId: process.pid,
    frameId: 0,
    returnValue: undefined as unknown,
    reply: (channel: string, ...args: unknown[]) => {
      broadcastFn(channel, args.length === 1 ? args[0] : args);
    },
    ports: [],
  } as unknown as IpcMainInvokeEvent & IpcMainEvent;
};

export class MobileBridgeService {
  private readonly bridgeKeyPair = createBridgeKeyPair();
  private readonly sessions = new Map<string, BridgeSessionRecord>();
  private readonly challenges = new Map<string, BridgeChallengeRecord>();
  private readonly wsClients = new Map<
    WebSocket,
    {
      subscriptions: Set<string>;
      authenticated: boolean;
      session: BridgeSessionRecord;
      encrypted: boolean;
    }
  >();

  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private registrationLeaseTimer: ReturnType<typeof setTimeout> | null = null;
  private port: number | null = null;
  private registrationLeaseExpiresAt: number | null = null;
  private registrationState: BridgeRegistrationState = "inactive";
  private deviceId: string | null = null;
  private hostAuthToken: string | null = null;
  private convexSiteUrl: string | null = null;
  private tunnelUrl: string | null = null;
  private healthFailureStreak = 0;
  private lastHealthyProbeAt = 0;
  private syncInFlight = false;
  private syncQueued = false;
  private getBootstrapPayload: (() => Promise<MobileBridgeBootstrap>) | null =
    null;
  private lastBootstrapPayload: MobileBridgeBootstrap | null = null;

  constructor(private readonly options: MobileBridgeServiceOptions) {}

  /**
   * Set a callback that reads the desktop renderer's bootstrap payload.
   * Used by `/bridge/bootstrap` to share session state with the mobile WebView.
   */
  setBootstrapPayloadGetter(getter: () => Promise<MobileBridgeBootstrap>) {
    this.getBootstrapPayload = getter;
  }

  private markClientActivity() {
    this.options.onClientActivity?.();
  }

  // ── External setters (called from bootstrap) ──────────────────────────

  setDeviceId(value: string | null) {
    this.deviceId = value?.trim() || null;
    void this.syncRegistration();
  }

  setHostAuthToken(value: string | null) {
    const previousToken = this.hostAuthToken;
    this.hostAuthToken = value?.trim() || null;
    if (!this.hostAuthToken && previousToken) {
      this.invalidateBridgeAccess("Desktop signed out");
      void this.clearRegistrationWithToken(previousToken);
      return;
    }
    void this.syncRegistration();
  }

  setConvexSiteUrl(value: string | null) {
    this.convexSiteUrl = value?.trim() || null;
    void this.syncRegistration();
  }

  setTunnelUrl(url: string | null) {
    const next = url?.trim() || null;
    if (next && next !== this.tunnelUrl) {
      // A freshly advertised URL starts with a clean health streak and must be
      // probed fresh (don't reuse a prior URL's cached result).
      this.healthFailureStreak = 0;
      this.lastHealthyProbeAt = 0;
    }
    this.tunnelUrl = next;
    void this.syncRegistration();
  }

  getPort(): number | null {
    return this.port;
  }

  private getBridgeOrigin() {
    if (!this.tunnelUrl) {
      return null;
    }
    try {
      return new URL(trimTrailingSlash(this.tunnelUrl)).origin;
    } catch {
      return null;
    }
  }

  private getRequestOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (typeof origin !== "string") {
      return null;
    }
    const trimmed = origin.trim();
    if (!trimmed || trimmed === "null") {
      return null;
    }
    try {
      return new URL(trimmed).origin;
    } catch {
      return null;
    }
  }

  private isAllowedRequestOrigin(origin: string | null) {
    if (!origin) {
      return true;
    }
    const bridgeOrigin = this.getBridgeOrigin();
    return Boolean(bridgeOrigin && origin === bridgeOrigin);
  }

  private getValidSession(req: IncomingMessage) {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }

    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[COOKIE_NAME];
    if (!sessionId) {
      return null;
    }

    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= now) {
      return null;
    }
    return session;
  }

  private pruneChallenges(now = Date.now()) {
    for (const [challengeId, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) {
        this.challenges.delete(challengeId);
      }
    }
  }

  private createBridgeChallenge() {
    const now = Date.now();
    this.pruneChallenges(now);
    const challengeId = crypto.randomUUID();
    const challenge = crypto.randomBytes(32).toString("base64url");
    const expiresAt = now + CHALLENGE_TTL_MS;
    this.challenges.set(challengeId, { challenge, expiresAt });
    return {
      challengeId,
      challenge,
      expiresAt,
      desktopDeviceId: this.deviceId,
      desktopPublicKey: this.bridgeKeyPair.publicKey,
      protocol: BRIDGE_CRYPTO_PROTOCOL,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start() {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        console.warn("[mobile-bridge] request failed:", error);
        if (!res.headersSent) {
          res.writeHead(500, {
            "Content-Type": "text/plain; charset=utf-8",
            ...NO_STORE_HEADERS,
          });
        }
        res.end("Mobile bridge request failed.");
      });
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws, req) => {
      void this.handleWebSocket(ws, req);
    });

    this.server.listen(0, "127.0.0.1", () => {
      const address = this.server?.address();
      if (address && typeof address === "object") {
        this.port = address.port;
        console.log(`[mobile-bridge] Listening on port ${this.port}`);
        void this.syncRegistration();
      }
    });

    this.refreshTimer = setInterval(() => {
      void this.syncRegistration();
    }, REGISTRATION_REFRESH_MS);
  }

  stop() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.clearRegistrationLeaseTimer();
    for (const [ws] of this.wsClients) {
      ws.close(1001, "Server shutting down");
    }
    this.wsClients.clear();
    this.wss?.close();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.port = null;
    this.sessions.clear();
    this.challenges.clear();
    void this.clearRegistration();
  }

  /** Broadcast an event to mobile WebSocket clients subscribed to a channel. */
  broadcastToMobile: MobileBroadcastFn = (channel, data) => {
    if (!isMobileBridgeEventChannel(channel)) {
      return;
    }
    if (
      channel === "display:update" &&
      !this.areDeveloperResourcePreviewsEnabled() &&
      this.isSourceDiffPayload(data)
    ) {
      return;
    }
    if (!this.isBridgeAccessEnabled()) {
      if (this.wsClients.size > 0 || this.sessions.size > 0) {
        this.expireBridgeAccess("Desktop bridge unavailable");
      }
      return;
    }
    for (const [ws, client] of this.wsClients) {
      if (
        client.authenticated &&
        client.subscriptions.has(channel) &&
        ws.readyState === WebSocket.OPEN
      ) {
        ws.send(
          this.serializeWsMessage(client, { type: "event", channel, data }),
        );
      }
    }
  };

  private areDeveloperResourcePreviewsEnabled() {
    return (
      this.lastBootstrapPayload?.localStorage?.[
        DEVELOPER_RESOURCE_PREVIEWS_KEY
      ] === "true"
    );
  }

  private isSourceDiffPayload(data: unknown) {
    return (
      Boolean(data) &&
      typeof data === "object" &&
      (data as { kind?: unknown }).kind === "source-diff"
    );
  }

  private clearRegistrationLeaseTimer() {
    if (this.registrationLeaseTimer) {
      clearTimeout(this.registrationLeaseTimer);
      this.registrationLeaseTimer = null;
    }
  }

  private closeBridgeClients(reason: string) {
    this.sessions.clear();
    this.challenges.clear();
    for (const [ws] of this.wsClients) {
      ws.close(4001, reason);
    }
    this.wsClients.clear();
  }

  private setRegistrationLease(expiresAt: number) {
    this.clearRegistrationLeaseTimer();
    this.registrationLeaseExpiresAt = expiresAt;
    this.registrationLeaseTimer = setTimeout(
      () => {
        if (!this.hasActiveRegistrationLease()) {
          this.expireBridgeAccess("Desktop bridge lease expired");
        }
      },
      Math.max(0, expiresAt - Date.now()),
    );
  }

  private expireBridgeAccess(reason: string) {
    this.clearRegistrationLeaseTimer();
    this.registrationLeaseExpiresAt = null;
    this.registrationState = "expired";
    this.closeBridgeClients(reason);
  }

  private invalidateBridgeAccess(reason: string) {
    this.clearRegistrationLeaseTimer();
    this.registrationLeaseExpiresAt = null;
    this.registrationState = "revoked";
    this.closeBridgeClients(reason);
  }

  private hasActiveRegistrationLease(nowMs = Date.now()) {
    return Boolean(
      typeof this.registrationLeaseExpiresAt === "number" &&
        this.registrationLeaseExpiresAt > nowMs,
    );
  }

  private isBridgeAccessEnabled() {
    return Boolean(
      this.hasActiveRegistrationLease() &&
        this.hostAuthToken &&
        this.convexSiteUrl &&
        this.deviceId,
    );
  }

  // ── HTTP request handling ─────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const requestOrigin = this.getRequestOrigin(req);

    if (!req.url) {
      sendJson(res, 400, { error: "Missing request URL." }, requestOrigin);
      return;
    }

    if (req.method === "OPTIONS") {
      if (!this.isAllowedRequestOrigin(requestOrigin)) {
        res.writeHead(403, { ...NO_STORE_HEADERS });
        res.end();
        return;
      }
      sendNoContent(res, requestOrigin);
      return;
    }

    if (!this.isAllowedRequestOrigin(requestOrigin)) {
      sendJson(res, 403, { error: "Forbidden" }, requestOrigin);
      return;
    }

    // Health check — no auth required
    if (
      req.url === "/bridge/health" ||
      req.url === "/__stella_mobile_bridge/health"
    ) {
      sendJson(res, 200, { ok: true }, requestOrigin);
      return;
    }

    if (req.url === "/bridge/challenge") {
      if (!this.isBridgeAccessEnabled()) {
        sendJson(
          res,
          403,
          { error: "Desktop bridge unavailable" },
          requestOrigin,
        );
        return;
      }
      sendJson(res, 200, this.createBridgeChallenge(), requestOrigin);
      return;
    }

    // Bootstrap payload — requires auth
    if (req.url === "/bridge/bootstrap") {
      const authenticated = await this.ensureAuthorized(
        req,
        res,
        requestOrigin,
      );
      if (!authenticated) return;
      await this.handleBootstrap(res, requestOrigin);
      return;
    }

    // IPC bridge — requires auth
    if (req.url.startsWith("/bridge/ipc/")) {
      const authenticated = await this.ensureAuthorized(
        req,
        res,
        requestOrigin,
      );
      if (!authenticated) return;
      await this.handleIpcRequest(req, res, requestOrigin, authenticated);
      return;
    }

    // Everything else: serve the desktop frontend (requires auth)
    const authenticated = await this.ensureAuthorized(req, res, requestOrigin);
    if (!authenticated) return;

    if (this.options.isDev) {
      await this.proxyToDevServer(req, res);
    } else {
      await this.serveStaticRenderer(req, res);
    }
  }

  // ── IPC routing ───────────────────────────────────────────────────────

  private decryptBridgePayload(
    session: BridgeSessionRecord,
    envelope: unknown,
  ): unknown {
    if (!session.crypto || !isBridgeEncryptedEnvelope(envelope)) {
      throw new Error("Encrypted bridge session required");
    }
    return decryptBridgePayload(session.crypto, "m2d", envelope);
  }

  private sendMaybeEncryptedJson(
    res: ServerResponse,
    status: number,
    data: unknown,
    origin: string | null,
    session: BridgeSessionRecord,
    encrypted: boolean,
  ) {
    if (!encrypted) {
      sendJson(res, status, data, origin);
      return;
    }
    if (!session.crypto) {
      sendJson(
        res,
        403,
        { error: "Encrypted bridge session required" },
        origin,
      );
      return;
    }
    sendJson(
      res,
      status,
      { envelope: encryptBridgePayload(session.crypto, "d2m", data) },
      origin,
    );
  }

  private async handleIpcRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestOrigin: string | null,
    session: BridgeSessionRecord,
  ) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const channel = decodeURIComponent(
      url.pathname.slice("/bridge/ipc/".length),
    );

    if (!isMobileBridgeRequestChannel(channel)) {
      sendJson(
        res,
        403,
        { error: `Disallowed IPC channel: ${channel}` },
        requestOrigin,
      );
      return;
    }

    try {
      const body = req.method === "POST" ? JSON.parse(await readBody(req)) : {};
      const encryptedRequest = isBridgeEncryptedEnvelope(body?.envelope);
      const decodedBody = encryptedRequest
        ? this.decryptBridgePayload(session, body.envelope)
        : body;
      const dispatchResult = await dispatchCapturedIpc(
        channel,
        (decodedBody as { args?: unknown }).args ?? [],
        this.broadcastToMobile,
        { swallowEventHandlerErrors: true },
      );
      if (dispatchResult.kind === "handle") {
        const { result } = dispatchResult;
        this.sendMaybeEncryptedJson(
          res,
          200,
          { result },
          requestOrigin,
          session,
          encryptedRequest,
        );
      } else {
        if (encryptedRequest) {
          this.sendMaybeEncryptedJson(
            res,
            200,
            { result: undefined },
            requestOrigin,
            session,
            true,
          );
        } else {
          sendNoContent(res, requestOrigin);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      if (message.startsWith("Unknown IPC channel:")) {
        sendJson(res, 404, { error: message }, requestOrigin);
      } else {
        console.error(`[mobile-bridge] IPC error on ${channel}: ${message}`);
        sendJson(res, 500, { error: message }, requestOrigin);
      }
    }
  }

  // ── Bootstrap payload (WebView session sharing) ─────────────────────

  private async handleBootstrap(
    res: ServerResponse,
    requestOrigin: string | null,
  ) {
    if (!this.getBootstrapPayload) {
      sendJson(res, 200, { localStorage: {} }, requestOrigin);
      return;
    }
    try {
      const payload = await this.getBootstrapPayload();
      this.lastBootstrapPayload = payload;
      sendJson(res, 200, payload, requestOrigin);
    } catch (error) {
      console.warn("[mobile-bridge] Failed to read bootstrap payload:", error);
      this.lastBootstrapPayload = null;
      sendJson(res, 200, { localStorage: {} }, requestOrigin);
    }
  }

  // ── WebSocket handling ────────────────────────────────────────────────

  private async handleWebSocket(ws: WebSocket, req: IncomingMessage) {
    const requestOrigin = this.getRequestOrigin(req);
    if (!this.isAllowedRequestOrigin(requestOrigin)) {
      ws.close(1008, "Forbidden");
      return;
    }

    if (!this.isBridgeAccessEnabled()) {
      ws.close(4001, "Unauthorized");
      return;
    }

    let session = this.getValidSession(req);
    if (!session) {
      session = await this.authorizeBridgeSession(req.headers);
    }
    if (!session) {
      ws.close(4001, "Unauthorized");
      return;
    }

    const client = {
      subscriptions: new Set<string>(),
      authenticated: true,
      session,
      encrypted:
        req.headers["x-stella-bridge-encrypted"] === BRIDGE_CRYPTO_PROTOCOL,
    };
    this.wsClients.set(ws, client);
    this.markClientActivity();
    console.log("[mobile-bridge] WebSocket connected");

    ws.on("message", (data) => {
      this.markClientActivity();
      if (!this.isBridgeAccessEnabled()) {
        ws.close(4001, "Desktop bridge unavailable");
        return;
      }
      try {
        const parsed = JSON.parse(data.toString()) as unknown;
        const msg = (
          isBridgeEncryptedEnvelope(
            (parsed as { envelope?: unknown })?.envelope,
          )
            ? this.decryptWsMessage(
                client,
                (parsed as { envelope: unknown }).envelope,
              )
            : parsed
        ) as {
          type: string;
          channel?: string;
          id?: string;
          args?: unknown[];
        };

        if (msg.type === "subscribe" && msg.channel) {
          if (
            isMobileBridgeEventChannel(msg.channel) &&
            !client.subscriptions.has(msg.channel)
          ) {
            client.subscriptions.add(msg.channel);
          }
        }

        if (msg.type === "unsubscribe" && msg.channel) {
          client.subscriptions.delete(msg.channel);
        }

        if (msg.type === "invoke" && msg.channel && msg.id) {
          if (!isMobileBridgeRequestChannel(msg.channel)) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                this.serializeWsMessage(client, {
                  type: "response",
                  id: msg.id,
                  error: `Disallowed IPC channel: ${msg.channel}`,
                }),
              );
            }
            return;
          }
          void this.handleWsInvoke(
            ws,
            client,
            msg.channel,
            msg.id,
            msg.args ?? [],
          );
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      this.wsClients.delete(ws);
      console.log("[mobile-bridge] WebSocket disconnected");
    });

    ws.on("error", (error) => {
      console.warn("[mobile-bridge] WebSocket error:", error.message);
    });
  }

  private decryptWsMessage(
    client: {
      session: BridgeSessionRecord;
      encrypted: boolean;
    },
    envelope: unknown,
  ): unknown {
    if (!client.session.crypto || !isBridgeEncryptedEnvelope(envelope)) {
      throw new Error("Encrypted bridge session required");
    }
    client.encrypted = true;
    return decryptBridgePayload(client.session.crypto, "m2d", envelope);
  }

  private serializeWsMessage(
    client: {
      session: BridgeSessionRecord;
      encrypted: boolean;
    },
    payload: unknown,
  ) {
    if (!client.encrypted) {
      return JSON.stringify(payload);
    }
    if (!client.session.crypto) {
      throw new Error("Encrypted bridge session required");
    }
    return JSON.stringify({
      envelope: encryptBridgePayload(client.session.crypto, "d2m", payload),
    });
  }

  private async handleWsInvoke(
    ws: WebSocket,
    client: {
      subscriptions: Set<string>;
      authenticated: boolean;
      session: BridgeSessionRecord;
      encrypted: boolean;
    },
    channel: string,
    id: string,
    args: unknown[],
  ) {
    try {
      const dispatchResult = await dispatchCapturedIpc(
        channel,
        args,
        this.broadcastToMobile,
      );
      if (dispatchResult.kind === "handle") {
        const { result } = dispatchResult;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            this.serializeWsMessage(client, { type: "response", id, result }),
          );
        }
      } else {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            this.serializeWsMessage(client, {
              type: "response",
              id,
              result: undefined,
            }),
          );
        }
      }
    } catch (error) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          this.serializeWsMessage(client, {
            type: "response",
            id,
            error: error instanceof Error ? error.message : "Internal error",
          }),
        );
      }
    }
  }

  // ── Auth (Convex-mediated) ────────────────────────────────────────────

  private async ensureAuthorized(
    req: IncomingMessage,
    res: ServerResponse,
    requestOrigin: string | null,
  ): Promise<BridgeSessionRecord | null> {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
    }

    if (!this.isBridgeAccessEnabled()) {
      sendJson(
        res,
        403,
        { error: "Desktop bridge unavailable" },
        requestOrigin,
      );
      return null;
    }

    const existingSession = this.getValidSession(req);
    if (existingSession) {
      this.markClientActivity();
      return existingSession;
    }

    const bridgeSession = await this.authorizeBridgeSession(req.headers);
    if (bridgeSession) {
      const sessionCookieId = crypto.randomUUID();
      this.sessions.set(sessionCookieId, bridgeSession);
      res.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${sessionCookieId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      );
      this.markClientActivity();
      return bridgeSession;
    }

    sendJson(res, 401, { error: "Unauthorized" }, requestOrigin);
    return null;
  }

  private async authorizeBridgeSession(
    requestHeaders: IncomingMessage["headers"],
  ): Promise<BridgeSessionRecord | null> {
    const convexSiteUrl = this.convexSiteUrl;
    const deviceId = this.deviceId;
    const hostAuthToken = this.hostAuthToken;
    if (!convexSiteUrl || !deviceId || !hostAuthToken) return null;

    const sessionId =
      typeof requestHeaders["x-stella-bridge-session-id"] === "string"
        ? requestHeaders["x-stella-bridge-session-id"].trim()
        : "";
    const sessionSecret =
      typeof requestHeaders["x-stella-bridge-session-secret"] === "string"
        ? requestHeaders["x-stella-bridge-session-secret"].trim()
        : "";
    const challengeId =
      typeof requestHeaders["x-stella-bridge-challenge-id"] === "string"
        ? requestHeaders["x-stella-bridge-challenge-id"].trim()
        : "";
    if (!sessionId || !sessionSecret || !challengeId) {
      return null;
    }

    const existing = this.sessions.get(sessionId);
    if (
      existing?.crypto &&
      existing.expiresAt > Date.now() &&
      existing.sessionSecret === sessionSecret
    ) {
      return existing;
    }

    this.pruneChallenges();
    const challenge = this.challenges.get(challengeId);
    if (!challenge) {
      return null;
    }

    try {
      const response = await this.postBridgeJson(
        convexSiteUrl,
        "/api/mobile/desktop-bridge/session/consume",
        `Bearer ${hostAuthToken}`,
        {
          deviceId,
          sessionId,
          sessionSecret,
          desktopChallenge: challenge.challenge,
        },
      );
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        mobileDeviceId?: unknown;
        mobilePublicKey?: unknown;
        desktopPublicKey?: unknown;
        desktopChallenge?: unknown;
        expiresAt?: unknown;
      };
      if (
        body.desktopChallenge !== challenge.challenge ||
        body.desktopPublicKey !== this.bridgeKeyPair.publicKey ||
        typeof body.mobilePublicKey !== "string" ||
        typeof body.mobileDeviceId !== "string" ||
        typeof body.expiresAt !== "number"
      ) {
        return null;
      }
      const session = {
        expiresAt: Math.min(body.expiresAt, Date.now() + SESSION_TTL_MS),
        mobileDeviceId: body.mobileDeviceId,
        sessionSecret,
        crypto: deriveBridgeCryptoSession({
          sessionId,
          secretKey: this.bridgeKeyPair.secretKey,
          peerPublicKey: body.mobilePublicKey,
          mobilePublicKey: body.mobilePublicKey,
          desktopPublicKey: this.bridgeKeyPair.publicKey,
        }),
      };
      this.challenges.delete(challengeId);
      this.sessions.set(sessionId, session);
      return session;
    } catch {
      return null;
    }
  }

  private postBridgeJson(
    siteUrl: string,
    route: string,
    authorization: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ) {
    return fetch(`${trimTrailingSlash(siteUrl)}${route}`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  }

  // ── Frontend serving ──────────────────────────────────────────────────

  private async proxyToDevServer(req: IncomingMessage, res: ServerResponse) {
    const target = new URL(
      req.url ?? "/",
      `${trimTrailingSlash(this.options.getDevServerUrl())}/`,
    );
    const method = req.method ?? "GET";
    const body =
      method === "GET" || method === "HEAD" ? undefined : await readBody(req);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) continue;
      const lower = key.toLowerCase();
      if (
        lower === "host" ||
        lower === "connection" ||
        lower === "authorization" ||
        lower === "cookie" ||
        lower === "content-length"
      ) {
        continue;
      }
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("accept-encoding", "identity");

    const upstream = await fetch(target, {
      method,
      headers,
      body: body ?? undefined,
      ...(body ? { duplex: "half" as const } : {}),
    });

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (
        lower === "content-length" ||
        lower === "set-cookie" ||
        lower === "content-encoding" ||
        lower === "connection"
      ) {
        return;
      }
      responseHeaders[key] = value;
    });

    res.writeHead(upstream.status, {
      ...responseHeaders,
      ...NO_STORE_HEADERS,
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(upstream.body as never).pipe(res);
      res.on("finish", resolve);
      res.on("error", reject);
    });
  }

  private async serveStaticRenderer(req: IncomingMessage, res: ServerResponse) {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const relativePath =
      requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const distRoot = path.resolve(this.options.electronDir, "../dist");
    const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
    const targetPath = path.join(distRoot, safePath);
    const fallbackPath = path.join(distRoot, "index.html");

    const filePath =
      fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()
        ? targetPath
        : fallbackPath;
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] ?? "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      ...NO_STORE_HEADERS,
    });
    fs.createReadStream(filePath).pipe(res);
  }

  // ── Convex registration ───────────────────────────────────────────────

  private async syncRegistration(): Promise<void> {
    // This runs from several setters plus the refresh timer, and now performs a
    // health probe that takes a moment. Serialize so two probes/registrations
    // never overlap, then run exactly one more pass if anything asked while we
    // were busy (so the latest state always wins).
    if (this.syncInFlight) {
      this.syncQueued = true;
      return;
    }
    this.syncInFlight = true;
    try {
      do {
        this.syncQueued = false;
        await this.performRegistrationSync();
      } while (this.syncQueued);
    } finally {
      this.syncInFlight = false;
    }
  }

  private async performRegistrationSync(): Promise<void> {
    if (
      !this.port ||
      !this.convexSiteUrl ||
      !this.hostAuthToken ||
      !this.deviceId
    ) {
      await this.clearRegistration();
      return;
    }

    if (!this.tunnelUrl) {
      await this.clearRegistration();
      return;
    }
    const baseUrls = [this.tunnelUrl];

    // Before (re)registering, confirm the advertised public URL is actually
    // serving. A registered-but-dead tunnel (e.g. cloudflared or its edge route
    // broke mid-session) would otherwise keep the phone pointed at an
    // unreachable URL until the 150s lease lapsed.
    let healthy: boolean;
    if (Date.now() - this.lastHealthyProbeAt < BRIDGE_PUBLIC_HEALTH_CACHE_MS) {
      // Reuse a very recent successful probe (collapses the duplicate probe from
      // a coalesced/burst sync). Anchored to the last real probe, so it never
      // extends itself across the far-spaced refresh ticks.
      healthy = true;
    } else {
      healthy = await this.probePublicTunnelHealth(this.tunnelUrl);
      if (healthy) {
        this.lastHealthyProbeAt = Date.now();
      }
    }
    if (!healthy) {
      this.healthFailureStreak += 1;
      if (
        this.healthFailureStreak >= BRIDGE_PUBLIC_HEALTH_FAILURE_THRESHOLD &&
        this.hasActiveRegistrationLease()
      ) {
        console.warn(
          `[mobile-bridge] Public tunnel failed ${this.healthFailureStreak} health checks; clearing availability`,
        );
        await this.clearRegistration();
        return;
      }
      // Below threshold: keep any existing lease but don't refresh the
      // registration against an unconfirmed URL this tick.
      if (this.hasActiveRegistrationLease()) {
        this.registrationState = "degraded";
      }
      return;
    }
    this.healthFailureStreak = 0;

    try {
      const response = await this.postBridgeJson(
        this.convexSiteUrl,
        "/api/mobile/desktop-bridge/register",
        `Bearer ${this.hostAuthToken}`,
        {
          deviceId: this.deviceId,
          baseUrls,
          platform: getDesktopPlatformLabel(),
          desktopPublicKey: this.bridgeKeyPair.publicKey,
        },
      );
      if (response.ok) {
        const body = (await response.json()) as {
          leaseExpiresAt?: unknown;
          leaseDurationMs?: unknown;
        };
        const expiresAt =
          typeof body.leaseExpiresAt === "number" &&
          Number.isFinite(body.leaseExpiresAt) &&
          body.leaseExpiresAt > Date.now()
            ? body.leaseExpiresAt
            : typeof body.leaseDurationMs === "number" &&
                Number.isFinite(body.leaseDurationMs) &&
                body.leaseDurationMs > 0
              ? Date.now() + body.leaseDurationMs
              : null;
        if (expiresAt === null) {
          throw new Error("Registration response missing a valid lease expiry");
        }
        this.setRegistrationLease(expiresAt);
        this.registrationState = "healthy";
        return;
      }

      if (response.status === 401 || response.status === 403) {
        this.invalidateBridgeAccess("Desktop bridge authorization expired");
        return;
      }

      if (this.hasActiveRegistrationLease()) {
        this.registrationState = "degraded";
      } else {
        this.expireBridgeAccess("Desktop bridge unavailable");
      }
      console.warn("[mobile-bridge] registration rejected:", response.status);
    } catch (error) {
      if (this.hasActiveRegistrationLease()) {
        this.registrationState = "degraded";
      } else {
        this.expireBridgeAccess("Desktop bridge unavailable");
      }
      console.warn("[mobile-bridge] registration failed:", error);
    }
  }

  private async probePublicTunnelHealth(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      BRIDGE_PUBLIC_HEALTH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`${trimTrailingSlash(url)}/bridge/health`, {
        method: "GET",
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async clearRegistration() {
    if (this.registrationLeaseExpiresAt === null || !this.hostAuthToken) {
      this.clearRegistrationLeaseTimer();
      this.registrationLeaseExpiresAt = null;
      this.registrationState = "inactive";
      this.closeBridgeClients("Desktop bridge unavailable");
      return;
    }
    await this.clearRegistrationWithToken(this.hostAuthToken);
  }

  private async clearRegistrationWithToken(token: string) {
    if (
      this.registrationLeaseExpiresAt === null ||
      !this.convexSiteUrl ||
      !this.deviceId
    ) {
      this.clearRegistrationLeaseTimer();
      this.registrationLeaseExpiresAt = null;
      this.registrationState = "inactive";
      this.closeBridgeClients("Desktop bridge unavailable");
      return;
    }

    try {
      await this.postBridgeJson(
        this.convexSiteUrl,
        "/api/mobile/desktop-bridge/clear",
        `Bearer ${token}`,
        { deviceId: this.deviceId },
      );
    } catch {
      // Ignore
    }

    this.clearRegistrationLeaseTimer();
    this.registrationLeaseExpiresAt = null;
    this.registrationState = "inactive";
    this.closeBridgeClients("Desktop bridge unavailable");
  }
}
