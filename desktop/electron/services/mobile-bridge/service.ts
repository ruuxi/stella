import crypto from "crypto";
import fs from "fs";
import http, { type IncomingMessage, type ServerResponse } from "http";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import { getHandler, getOnHandlers } from "./handler-registry.js";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

const REGISTRATION_REFRESH_MS = 60_000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const COOKIE_NAME = "stella_mobile_bridge";
const MAX_BODY_SIZE = 5 * 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

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

const getBridgeUrls = (port: number) => {
  const urls = new Set<string>();
  const interfaces = os.networkInterfaces();

  for (const records of Object.values(interfaces)) {
    for (const record of records ?? []) {
      if (!record || record.internal || record.family !== "IPv4") {
        continue;
      }
      urls.add(`http://${record.address}:${port}`);
    }
  }

  return [...urls].sort((left, right) => left.localeCompare(right));
};

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

const sendJson = (res: ServerResponse, status: number, data: unknown) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...NO_STORE_HEADERS,
  });
  res.end(body);
};

/**
 * Fake IPC event for bridging — handlers check sender URL for privilege
 * (loopback is trusted). sender.send() routes to mobile WebSocket clients.
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
      getURL: () => "http://localhost",
      isDestroyed: () => false,
    },
    senderFrame: { url: "http://localhost" },
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

  constructor(private readonly options: MobileBridgeServiceOptions) {}

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

    this.server.listen(0, "0.0.0.0", () => {
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
      this.registered
      && this.hostAuthToken
      && this.convexSiteUrl
      && this.deviceId,
    );
  }

  // ── HTTP request handling ─────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    if (!req.url) {
      sendJson(res, 400, { error: "Missing request URL." });
      return;
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    // Health check — no auth required
    if (
      req.url === "/bridge/health" ||
      req.url === "/__stella_mobile_bridge/health"
    ) {
      sendJson(res, 200, { ok: true });
      return;
    }

    // IPC bridge — requires auth
    if (req.url.startsWith("/bridge/ipc/")) {
      const authenticated = await this.ensureAuthorized(req, res);
      if (!authenticated) return;
      await this.handleIpcRequest(req, res);
      return;
    }

    // Everything else: serve the desktop frontend (requires auth)
    const authenticated = await this.ensureAuthorized(req, res);
    if (!authenticated) return;

    if (this.options.isDev) {
      await this.proxyToDevServer(req, res);
    } else {
      await this.serveStaticRenderer(req, res);
    }
  }

  // ── IPC routing ───────────────────────────────────────────────────────

  private async handleIpcRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const channel = decodeURIComponent(
      url.pathname.slice("/bridge/ipc/".length),
    );

    const handleHandler = getHandler(channel);
    const onHandlerList = !handleHandler ? getOnHandlers(channel) : undefined;

    if (!handleHandler && (!onHandlerList || onHandlerList.length === 0)) {
      sendJson(res, 404, { error: `Unknown IPC channel: ${channel}` });
      return;
    }

    try {
      const body =
        req.method === "POST" ? JSON.parse(await readBody(req)) : {};
      const args = body.args ?? [];
      const fakeEvent = createFakeIpcEvent(this.broadcastToMobile);
      const spreadArgs = Array.isArray(args) ? args : [args];

      if (handleHandler) {
        const result = await handleHandler(fakeEvent, ...spreadArgs);
        sendJson(res, 200, { result });
      } else {
        for (const handler of onHandlerList!) {
          try {
            handler(
              fakeEvent as unknown as IpcMainEvent,
              ...spreadArgs,
            );
          } catch (handlerErr) {
            console.warn(
              `[mobile-bridge] on-handler error for ${channel}:`,
              (handlerErr as Error).message,
            );
          }
        }
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          ...NO_STORE_HEADERS,
        });
        res.end();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Internal error";
      console.error(`[mobile-bridge] IPC error on ${channel}: ${message}`);
      sendJson(res, 500, { error: message });
    }
  }

  // ── WebSocket handling ────────────────────────────────────────────────

  private handleWebSocket(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");

    if (!token || !this.isBridgeAccessEnabled()) {
      ws.close(4001, "Unauthorized");
      return;
    }

    // Validate token asynchronously
    void this.authorizeBearer(`Bearer ${token}`).then((authorized) => {
      if (!authorized) {
        ws.close(4001, "Unauthorized");
        return;
      }

      const client = {
        subscriptions: new Map<string, () => void>(),
        authenticated: true,
      };
      this.wsClients.set(ws, client);
      console.log("[mobile-bridge] WebSocket connected");

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            type: string;
            channel?: string;
            id?: string;
            args?: unknown[];
          };

          if (msg.type === "subscribe" && msg.channel) {
            if (!client.subscriptions.has(msg.channel)) {
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
          ws.send(
            JSON.stringify({ type: "response", id, result: undefined }),
          );
        }
      }
    } catch (error) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "response",
            id,
            error:
              error instanceof Error ? error.message : "Internal error",
          }),
        );
      }
    }
  }

  // ── Auth (Convex-mediated) ────────────────────────────────────────────

  private async ensureAuthorized(req: IncomingMessage, res: ServerResponse) {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
    }

    if (!this.isBridgeAccessEnabled()) {
      sendJson(res, 403, { error: "Desktop bridge unavailable" });
      return false;
    }

    // Check existing session cookie
    const cookies = parseCookies(req.headers.cookie);
    const existingSession = cookies[COOKIE_NAME];
    if (existingSession) {
      const match = this.sessions.get(existingSession);
      if (match && match.expiresAt > now) return true;
    }

    // Validate Bearer token
    const authorization = req.headers.authorization?.trim();
    if (!authorization?.startsWith("Bearer ")) {
      sendJson(res, 401, { error: "Unauthorized" });
      return false;
    }

    const authorized = await this.authorizeBearer(authorization);
    if (!authorized) {
      sendJson(res, 403, { error: "Forbidden" });
      return false;
    }

    // Create session cookie for future requests
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { expiresAt: now + SESSION_TTL_MS });
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    );
    return true;
  }

  private async authorizeBearer(authorization: string) {
    const convexSiteUrl = this.convexSiteUrl;
    const deviceId = this.deviceId;
    if (!convexSiteUrl || !deviceId) return false;

    try {
      const response = await fetch(
        `${trimTrailingSlash(convexSiteUrl)}/api/mobile/desktop-bridge/authorize`,
        {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ deviceId }),
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  // ── Frontend serving ──────────────────────────────────────────────────

  private async proxyToDevServer(req: IncomingMessage, res: ServerResponse) {
    const target = new URL(
      req.url ?? "/",
      `${trimTrailingSlash(this.options.getDevServerUrl())}/`,
    );
    const method = req.method ?? "GET";
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : await readBody(req);

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

    const localUrls = getBridgeUrls(this.port);
    const baseUrls = [
      ...(this.tunnelUrl ? [this.tunnelUrl] : []),
      ...localUrls,
    ];
    if (baseUrls.length === 0) {
      await this.clearRegistration();
      return;
    }

    try {
      const response = await fetch(
        `${trimTrailingSlash(this.convexSiteUrl)}/api/mobile/desktop-bridge/register`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.hostAuthToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            deviceId: this.deviceId,
            baseUrls,
            platform: getDesktopPlatformLabel(),
          }),
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
      await fetch(
        `${trimTrailingSlash(this.convexSiteUrl)}/api/mobile/desktop-bridge/clear`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ deviceId: this.deviceId }),
        },
      );
    } catch {
      // Ignore
    }

    this.registered = false;
  }
}
