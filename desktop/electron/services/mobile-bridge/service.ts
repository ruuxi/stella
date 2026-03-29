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
import { getHandler, getOnHandlers } from "./handler-registry.js";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

const REGISTRATION_REFRESH_MS = 60_000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const COOKIE_NAME = "stella_mobile_bridge";
const MAX_BODY_SIZE = 5 * 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const ALLOW_METHODS = "GET, POST, OPTIONS";
const ALLOW_HEADERS =
  "Content-Type, Authorization, X-Stella-Mobile-Device-Id, X-Stella-Mobile-Pair-Secret";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const MOBILE_BRIDGE_SENDER_URL = "stella-mobile-bridge://mobile";

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
};

export type MobileBroadcastFn = (channel: string, data: unknown) => void;

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
  private readonly sessions = new Map<string, BridgeSessionRecord>();
  private readonly wsClients = new Map<
    WebSocket,
    { subscriptions: Map<string, () => void>; authenticated: boolean }
  >();

  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private port: number | null = null;
  private registered = false;
  private deviceId: string | null = null;
  private hostAuthToken: string | null = null;
  private convexSiteUrl: string | null = null;
  private tunnelUrl: string | null = null;
  private getBootstrapPayload: (() => Promise<MobileBridgeBootstrap>) | null =
    null;

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
    this.tunnelUrl = url?.trim() || null;
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
    return { sessionId, expiresAt: session.expiresAt };
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
    this.wss.on("connection", (ws, req) => this.handleWebSocket(ws, req));

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
    for (const [ws, client] of this.wsClients) {
      for (const unsub of client.subscriptions.values()) unsub();
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
    void this.clearRegistration();
  }

  /** Broadcast an event to mobile WebSocket clients subscribed to a channel. */
  broadcastToMobile: MobileBroadcastFn = (channel, data) => {
    if (!isMobileBridgeEventChannel(channel)) {
      return;
    }
    const message = JSON.stringify({ type: "event", channel, data });
    for (const [ws, client] of this.wsClients) {
      if (
        client.authenticated &&
        client.subscriptions.has(channel) &&
        ws.readyState === WebSocket.OPEN
      ) {
        ws.send(message);
      }
    }
  };

  private invalidateBridgeAccess(reason: string) {
    this.registered = false;
    this.sessions.clear();

    for (const [ws, client] of this.wsClients) {
      for (const unsub of client.subscriptions.values()) {
        unsub();
      }
      ws.close(4001, reason);
    }
    this.wsClients.clear();
  }

  private isBridgeAccessEnabled() {
    return Boolean(
      this.registered &&
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
      await this.handleIpcRequest(req, res, requestOrigin);
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

  private async handleIpcRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestOrigin: string | null,
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

    const handleHandler = getHandler(channel);
    const onHandlerList = !handleHandler ? getOnHandlers(channel) : undefined;

    if (!handleHandler && (!onHandlerList || onHandlerList.length === 0)) {
      sendJson(
        res,
        404,
        { error: `Unknown IPC channel: ${channel}` },
        requestOrigin,
      );
      return;
    }

    try {
      const body = req.method === "POST" ? JSON.parse(await readBody(req)) : {};
      const args = body.args ?? [];
      const fakeEvent = createFakeIpcEvent(this.broadcastToMobile);
      const spreadArgs = Array.isArray(args) ? args : [args];

      if (handleHandler) {
        const result = await handleHandler(fakeEvent, ...spreadArgs);
        sendJson(res, 200, { result }, requestOrigin);
      } else {
        for (const handler of onHandlerList!) {
          try {
            handler(fakeEvent as unknown as IpcMainEvent, ...spreadArgs);
          } catch (handlerErr) {
            console.warn(
              `[mobile-bridge] on-handler error for ${channel}:`,
              (handlerErr as Error).message,
            );
          }
        }
        sendNoContent(res, requestOrigin);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      console.error(`[mobile-bridge] IPC error on ${channel}: ${message}`);
      sendJson(res, 500, { error: message }, requestOrigin);
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
      sendJson(res, 200, payload, requestOrigin);
    } catch (error) {
      console.warn("[mobile-bridge] Failed to read bootstrap payload:", error);
      sendJson(res, 200, { localStorage: {} }, requestOrigin);
    }
  }

  // ── WebSocket handling ────────────────────────────────────────────────

  private handleWebSocket(ws: WebSocket, req: IncomingMessage) {
    const requestOrigin = this.getRequestOrigin(req);
    if (!this.isAllowedRequestOrigin(requestOrigin)) {
      ws.close(1008, "Forbidden");
      return;
    }

    if (!this.isBridgeAccessEnabled()) {
      ws.close(4001, "Unauthorized");
      return;
    }

    if (!this.getValidSession(req)) {
      ws.close(4001, "Unauthorized");
      return;
    }

    const client = {
      subscriptions: new Map<string, () => void>(),
      authenticated: true,
    };
    this.wsClients.set(ws, client);
    this.markClientActivity();
    console.log("[mobile-bridge] WebSocket connected");

    ws.on("message", (data) => {
      this.markClientActivity();
      try {
        const msg = JSON.parse(data.toString()) as {
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
            client.subscriptions.set(msg.channel, () => {});
          }
        }

        if (msg.type === "unsubscribe" && msg.channel) {
          const unsub = client.subscriptions.get(msg.channel);
          if (unsub) {
            unsub();
            client.subscriptions.delete(msg.channel);
          }
        }

        if (msg.type === "invoke" && msg.channel && msg.id) {
          if (!isMobileBridgeRequestChannel(msg.channel)) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "response",
                  id: msg.id,
                  error: `Disallowed IPC channel: ${msg.channel}`,
                }),
              );
            }
            return;
          }
          void this.handleWsInvoke(ws, msg.channel, msg.id, msg.args ?? []);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      for (const unsub of client.subscriptions.values()) unsub();
      this.wsClients.delete(ws);
      console.log("[mobile-bridge] WebSocket disconnected");
    });

    ws.on("error", (error) => {
      console.warn("[mobile-bridge] WebSocket error:", error.message);
    });
  }

  private async handleWsInvoke(
    ws: WebSocket,
    channel: string,
    id: string,
    args: unknown[],
  ) {
    const handleHandler = getHandler(channel);
    const onHandlerList = !handleHandler ? getOnHandlers(channel) : undefined;

    if (!handleHandler && (!onHandlerList || onHandlerList.length === 0)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "response",
            id,
            error: `Unknown channel: ${channel}`,
          }),
        );
      }
      return;
    }

    const fakeEvent = createFakeIpcEvent(this.broadcastToMobile);
    const spreadArgs = Array.isArray(args) ? args : [];

    try {
      if (handleHandler) {
        const result = await handleHandler(fakeEvent, ...spreadArgs);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", id, result }));
        }
      } else {
        for (const handler of onHandlerList!) {
          handler(fakeEvent as unknown as IpcMainEvent, ...spreadArgs);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", id, result: undefined }));
        }
      }
    } catch (error) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
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
  ) {
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
      return false;
    }

    const existingSession = this.getValidSession(req);
    if (existingSession) {
      this.markClientActivity();
      return true;
    }

    const authorization = req.headers.authorization?.trim();
    if (!authorization?.startsWith("Bearer ")) {
      sendJson(res, 401, { error: "Unauthorized" }, requestOrigin);
      return false;
    }

    const authorized = await this.authorizeBearer(authorization, req.headers);
    if (!authorized) {
      sendJson(res, 403, { error: "Forbidden" }, requestOrigin);
      return false;
    }

    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { expiresAt: now + SESSION_TTL_MS });
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    );
    this.markClientActivity();
    return true;
  }

  private async authorizeBearer(
    authorization: string,
    requestHeaders: IncomingMessage["headers"],
  ) {
    const convexSiteUrl = this.convexSiteUrl;
    const deviceId = this.deviceId;
    if (!convexSiteUrl || !deviceId) return false;

    const mobileDeviceId =
      typeof requestHeaders["x-stella-mobile-device-id"] === "string"
        ? requestHeaders["x-stella-mobile-device-id"].trim()
        : "";
    const pairSecret =
      typeof requestHeaders["x-stella-mobile-pair-secret"] === "string"
        ? requestHeaders["x-stella-mobile-pair-secret"].trim()
        : "";
    if (!mobileDeviceId || !pairSecret) {
      return false;
    }

    try {
      const response = await this.postBridgeJson(
        convexSiteUrl,
        "/api/mobile/desktop-bridge/authorize",
        authorization,
        { deviceId },
        {
          "X-Stella-Mobile-Device-Id": mobileDeviceId,
          "X-Stella-Mobile-Pair-Secret": pairSecret,
        },
      );
      return response.ok;
    } catch {
      return false;
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

  private async syncRegistration() {
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

    try {
      const response = await this.postBridgeJson(
        this.convexSiteUrl,
        "/api/mobile/desktop-bridge/register",
        `Bearer ${this.hostAuthToken}`,
        {
          deviceId: this.deviceId,
          baseUrls,
          platform: getDesktopPlatformLabel(),
        },
      );
      this.registered = Boolean(response?.ok);
    } catch (error) {
      console.warn("[mobile-bridge] registration failed:", error);
    }
  }

  private async clearRegistration() {
    if (!this.registered || !this.hostAuthToken) {
      this.registered = false;
      return;
    }
    await this.clearRegistrationWithToken(this.hostAuthToken);
  }

  private async clearRegistrationWithToken(token: string) {
    if (!this.registered || !this.convexSiteUrl || !this.deviceId) {
      this.registered = false;
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

    this.registered = false;
  }
}
