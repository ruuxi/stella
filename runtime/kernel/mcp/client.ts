import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { loadMcpAccessToken } from "./oauth.js";
import type { McpCallResult, McpServerConfig, McpToolInfo } from "./types.js";

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
    parts.push((await loadMcpAccessToken(stellaRoot, match[1])) ?? match[0]);
    cursor = match.index + match[0].length;
  }
  parts.push(value.slice(cursor));
  return parts.join("");
};

class HttpMcpSession {
  private sessionId: string | null = null;
  private initialized = false;

  constructor(
    private readonly stellaRoot: string,
    private readonly server: McpServerConfig,
  ) {}

  private async headers() {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(this.server.headers ?? {}),
    };
    const token = await loadMcpAccessToken(this.stellaRoot, this.server.auth?.tokenKey);
    if (token) {
      const scheme = this.server.auth?.scheme ?? "bearer";
      const value =
        scheme === "raw" ? token : scheme === "basic" ? `Basic ${token}` : `Bearer ${token}`;
      headers[this.server.auth?.headerName ?? "authorization"] = value;
    }
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }
    return headers;
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.server.url) throw new Error(`${this.server.displayName} does not have a URL.`);
    const id = randomUUID();
    const response = await fetch(this.server.url, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    const responseSessionId = response.headers.get("mcp-session-id");
    if (responseSessionId) this.sessionId = responseSessionId;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${this.server.displayName} MCP request failed (${response.status}): ${text.slice(0, 500)}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const messages = contentType.includes("text/event-stream")
      ? parseSseMessages(text)
      : [JSON.parse(text) as RpcMessage];
    const message = messages.find((entry) => String(entry.id) === id);
    if (!message) {
      throw new Error(`${this.server.displayName} did not return a response for ${method}.`);
    }
    if (message.error) {
      throw new Error(message.error.message ?? `${method} failed.`);
    }
    return message.result;
  }

  private async notify(method: string, params?: unknown) {
    if (!this.server.url) return;
    await fetch(this.server.url, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
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

  async listTools(): Promise<McpToolInfo[]> {
    await this.initialize();
    const result = await this.request("tools/list");
    const tools = (result as { tools?: unknown[] })?.tools;
    return Array.isArray(tools) ? (tools as McpToolInfo[]) : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.initialize();
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    });
    return result as McpCallResult;
  }
}

class StdioMcpSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private initialized = false;

  constructor(
    private readonly stellaRoot: string,
    private readonly server: McpServerConfig,
  ) {}

  private async start() {
    if (this.child) return;
    if (!this.server.command) {
      throw new Error(`${this.server.displayName} does not have a command.`);
    }
    this.child = spawn(this.server.command, this.server.args ?? [], {
      env: {
        ...process.env,
        ...(await resolveSecretPlaceholders(this.stellaRoot, this.server.env)),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", () => {
      // Drain diagnostics so verbose MCP servers cannot block on a full pipe.
    });
    this.child.on("exit", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`${this.server.displayName} exited.`));
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
        pending.reject(new Error(message.error.message ?? "MCP request failed."));
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
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    })}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`${this.server.displayName} timed out waiting for ${method}.`));
        }
      }, 60_000);
    });
  }

  private async notify(method: string, params?: unknown) {
    await this.start();
    this.child?.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    })}\n`);
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

  async listTools(): Promise<McpToolInfo[]> {
    await this.initialize();
    const result = await this.request("tools/list");
    const tools = (result as { tools?: unknown[] })?.tools;
    return Array.isArray(tools) ? (tools as McpToolInfo[]) : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.initialize();
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    });
    return result as McpCallResult;
  }
}

const sessions = new Map<string, HttpMcpSession | StdioMcpSession>();

const getSession = (stellaRoot: string, server: McpServerConfig) => {
  const key = `${stellaRoot}:${server.id}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  const session =
    server.transport === "stdio"
      ? new StdioMcpSession(stellaRoot, server)
      : new HttpMcpSession(stellaRoot, server);
  sessions.set(key, session);
  return session;
};

export const listMcpServerTools = async (
  stellaRoot: string,
  server: McpServerConfig,
) => getSession(stellaRoot, server).listTools();

export const callMcpServerTool = async (
  stellaRoot: string,
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
) => getSession(stellaRoot, server).callTool(toolName, args);
