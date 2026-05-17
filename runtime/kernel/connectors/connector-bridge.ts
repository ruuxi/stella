import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { loadConnectorAccessToken } from "./oauth.js";
import type {
  ConnectorToolCallResult,
  ConnectorCommandConfig,
  ConnectorToolInfo,
} from "./types.js";

/** Thrown when a connector request comes back with an HTTP auth status
 *  (401/403/407). Lets callers (e.g. `stella-connect import-mcp`) branch
 *  on auth failure vs. real probe errors without parsing message strings. */
export class ConnectorAuthError extends Error {
  readonly kind = "auth_required" as const;
  constructor(
    readonly status: number,
    readonly serverDisplayName: string,
    readonly tokenKey: string | undefined,
    bodyPreview: string,
  ) {
    super(
      `${serverDisplayName} connector request failed (${status}): ${bodyPreview.slice(0, 500)}`,
    );
    this.name = "ConnectorAuthError";
  }
}

const AUTH_STATUSES = new Set([401, 403, 407]);

type RpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

const parseSseMessages = (text: string): RpcMessage[] => {
  const messages: RpcMessage[] = [];
  for (const block of text.split(/\n\n+/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      messages.push(JSON.parse(data) as RpcMessage);
    } catch {
      // Ignore malformed non-RPC SSE frames.
    }
  }
  return messages;
};

const resolveSecretPlaceholders = async (
  stellaRoot: string,
  values: Record<string, string> = {},
) => {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = await replaceSecretPlaceholders(stellaRoot, value);
  }
  return resolved;
};

const replaceSecretPlaceholders = async (stellaRoot: string, value: string) => {
  const parts: string[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/\$\{([a-zA-Z0-9_.-]+)\}/gu)) {
    parts.push(value.slice(cursor, match.index));
    parts.push(
      (await loadConnectorAccessToken(stellaRoot, match[1])) ?? match[0],
    );
    cursor = match.index + match[0].length;
  }
  parts.push(value.slice(cursor));
  return parts.join("");
};

class HttpConnectorBridgeSession {
  private sessionId: string | null = null;
  private initialized = false;

  constructor(
    private readonly stellaRoot: string,
    private readonly server: ConnectorCommandConfig,
  ) {}

  private async headers() {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(this.server.headers ?? {}),
    };
    const token = await loadConnectorAccessToken(
      this.stellaRoot,
      this.server.auth?.tokenKey,
    );
    if (token) {
      const scheme = this.server.auth?.scheme ?? "bearer";
      const value =
        scheme === "raw"
          ? token
          : scheme === "basic"
            ? `Basic ${token}`
            : `Bearer ${token}`;
      headers[this.server.auth?.headerName ?? "authorization"] = value;
    } else if (this.server.auth?.type && this.server.auth.type !== "none") {
      throw new ConnectorAuthError(
        0,
        this.server.displayName,
        this.server.auth.tokenKey,
        `${this.server.displayName} has no stored credential for tokenKey "${this.server.auth.tokenKey}".`,
      );
    }
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }
    return headers;
  }

  private async request(
    method: string,
    params?: unknown,
    recoverSession = true,
  ): Promise<unknown> {
    if (!this.server.url)
      throw new Error(`${this.server.displayName} does not have a URL.`);
    const id = randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let response: Response;
    try {
      response = await fetch(this.server.url, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `${this.server.displayName} timed out waiting for ${method}.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const responseSessionId = response.headers.get("mcp-session-id");
    if (responseSessionId) this.sessionId = responseSessionId;
    const text = await response.text();
    if (!response.ok) {
      if (
        response.status === 404 &&
        recoverSession &&
        this.sessionId &&
        method !== "initialize"
      ) {
        this.sessionId = null;
        this.initialized = false;
        await this.initialize();
        return await this.request(method, params, false);
      }
      if (AUTH_STATUSES.has(response.status)) {
        throw new ConnectorAuthError(
          response.status,
          this.server.displayName,
          this.server.auth?.tokenKey,
          text,
        );
      }
      throw new Error(
        `${this.server.displayName} connector request failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    const messages = contentType.includes("text/event-stream")
      ? parseSseMessages(text)
      : [JSON.parse(text) as RpcMessage];
    const message = messages.find((entry) => String(entry.id) === id);
    if (!message) {
      throw new Error(
        `${this.server.displayName} did not return a response for ${method}.`,
      );
    }
    if (message.error) {
      throw new Error(message.error.message ?? `${method} failed.`);
    }
    return message.result;
  }

  private async notify(method: string, params?: unknown) {
    if (!this.server.url) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      await fetch(this.server.url, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          ...(params === undefined ? {} : { params }),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async initialize() {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stella", version: "0" },
    });
    await this.notify("notifications/initialized");
    this.initialized = true;
  }

  async listTools(): Promise<ConnectorToolInfo[]> {
    await this.initialize();
    const result = await this.request("tools/list");
    const tools = (result as { tools?: unknown[] })?.tools;
    return Array.isArray(tools) ? (tools as ConnectorToolInfo[]) : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ConnectorToolCallResult> {
    await this.initialize();
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    });
    return result as ConnectorToolCallResult;
  }

  close() {
    this.sessionId = null;
    this.initialized = false;
  }
}

class StdioConnectorBridgeSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private initialized = false;

  constructor(
    private readonly stellaRoot: string,
    private readonly server: ConnectorCommandConfig,
  ) {}

  private async start() {
    if (this.child) return;
    if (!this.server.command) {
      throw new Error(`${this.server.displayName} does not have a command.`);
    }
    this.child = spawn(this.server.command, this.server.args ?? [], {
      cwd: this.server.cwd,
      env: {
        ...process.env,
        ...(await resolveSecretPlaceholders(this.stellaRoot, this.server.env)),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", () => {
      // Drain diagnostics so verbose connector commands cannot block on a full pipe.
    });
    this.child.on("exit", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`${this.server.displayName} exited.`));
      }
      this.pending.clear();
      this.child = null;
      this.initialized = false;
    });
    this.child.on("error", (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.initialized = false;
    });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "connector request failed."),
        );
      } else {
        pending.resolve(message.result);
      }
    });
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error(`${this.server.displayName} is not running.`);
    const id = String(this.nextId++);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`,
    );
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new Error(
              `${this.server.displayName} timed out waiting for ${method}.`,
            ),
          );
        }
      }, 60_000);
    });
  }

  private async notify(method: string, params?: unknown) {
    await this.start();
    this.child?.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`,
    );
  }

  async initialize() {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stella", version: "0" },
    });
    await this.notify("notifications/initialized");
    this.initialized = true;
  }

  async listTools(): Promise<ConnectorToolInfo[]> {
    await this.initialize();
    const result = await this.request("tools/list");
    const tools = (result as { tools?: unknown[] })?.tools;
    return Array.isArray(tools) ? (tools as ConnectorToolInfo[]) : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ConnectorToolCallResult> {
    await this.initialize();
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    });
    return result as ConnectorToolCallResult;
  }

  close() {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(`${this.server.displayName} was disconnected.`));
    }
    this.pending.clear();
    this.child?.kill();
    this.child = null;
    this.initialized = false;
  }
}

const sessions = new Map<
  string,
  HttpConnectorBridgeSession | StdioConnectorBridgeSession
>();

const getSession = (stellaRoot: string, server: ConnectorCommandConfig) => {
  const key = `${stellaRoot}:${server.id}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  const session =
    server.transport === "stdio"
      ? new StdioConnectorBridgeSession(stellaRoot, server)
      : new HttpConnectorBridgeSession(stellaRoot, server);
  sessions.set(key, session);
  return session;
};

export const listConnectorBridgeTools = async (
  stellaRoot: string,
  server: ConnectorCommandConfig,
) => getSession(stellaRoot, server).listTools();

export const callConnectorBridgeTool = async (
  stellaRoot: string,
  server: ConnectorCommandConfig,
  toolName: string,
  args: Record<string, unknown>,
) => getSession(stellaRoot, server).callTool(toolName, args);

export const closeConnectorBridgeSessions = (
  stellaRoot: string,
  serverIds: Iterable<string>,
) => {
  for (const serverId of serverIds) {
    const key = `${stellaRoot}:${serverId}`;
    const session = sessions.get(key);
    session?.close();
    sessions.delete(key);
  }
};
