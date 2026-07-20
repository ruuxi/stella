import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import type { Socket } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import type {
  ToolMetadata,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";
import { extractAttachImageBlocks } from "../agent-runtime/tool-adapters.js";

const HOST = "127.0.0.1";
const MAX_TOOL_RESULT_CHARS = 80_000;
const MAX_SETTLED_CALL_LEDGER_ENTRIES = 512;

export type ClaudeCodeToolMcpActiveTurn = {
  /** Stable Stella run identity; survives a Claude process restart. */
  identityScope?: string;
  /** Resolve the engine-persisted Anthropic tool_use id for this MCP call. */
  claimNativeToolUseId?: (
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<string>;
  executeTool: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  onToolUpdate?: (args: {
    toolCallId: string;
    toolName: string;
    update: ToolResult;
  }) => void;
  onToolResult?: (args: {
    toolCallId: string;
    toolName: string;
    result: ToolResult;
  }) => void;
  /** Called only after the MCP HTTP response has been flushed to the socket. */
  onToolResponseWritten?: (args: {
    toolCallId: string;
    toolName: string;
  }) => void | Promise<void>;
};

export type ClaudeCodeToolMcpHost = {
  /** Authenticated, loopback-only Streamable HTTP MCP endpoint. */
  url: string;
  /** Header value rather than the raw token so callers never need to format it. */
  authorizationHeader: string;
  /** Stable digest of the immutable tool catalog exposed by this host. */
  toolCatalogHash: string;
  /** Object accepted as one entry in Claude Code's `mcpServers` config. */
  mcpServerConfig: {
    type: "http";
    url: string;
    headers: { Authorization: string };
  };
  /** Abort tools owned by a dying Claude process without closing the host. */
  abortActiveCalls: (reason?: unknown) => void;
  /** Drop MCP transports owned by a dead Claude process generation. */
  resetClientSessions: (reason?: unknown) => Promise<void>;
  close: () => Promise<void>;
};

export type CreateClaudeCodeToolMcpHostOptions = {
  tools: readonly ToolMetadata[];
  /** Persisted Stella session identity, not an MCP transport session id. */
  identityScope?: string;
  /**
   * Resolved for every native MCP call. The host is session-scoped while the
   * execution callback and cancellation boundary are turn-scoped.
   */
  getActiveTurn: () => ClaudeCodeToolMcpActiveTurn | undefined;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const stringifyUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const summarizeUpdate = (update: ToolResult): string => {
  if (update.error) return update.error;
  const text = stringifyUnknown(update.result);
  return text.length > 1_000 ? `${text.slice(0, 1_000)}...` : text;
};

const trimToolResult = (value: string): string =>
  value.length <= MAX_TOOL_RESULT_CHARS
    ? value
    : `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[tool result truncated]`;

const toolResultToMcp = async (result: ToolResult): Promise<CallToolResult> => {
  const rawResult = stringifyUnknown(result.result);
  const { text: resolvedResult, images } = await extractAttachImageBlocks(
    rawResult,
    { provider: "anthropic" },
  );
  const hasDetails = result.details !== undefined;
  const text = trimToolResult(
    result.error
      ? `Error: ${result.error}`
      : hasDetails
        ? stringifyUnknown({
            result: resolvedResult || result.result,
            details: result.details,
          })
        : resolvedResult,
  );
  const content: CallToolResult["content"] = [];
  if (text || images.length === 0) {
    content.push({ type: "text", text });
  }
  for (const image of images) {
    content.push({
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
    });
  }
  return {
    content,
    ...(result.error ? { isError: true } : {}),
  };
};

const unauthorized = (response: http.ServerResponse) => {
  response.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": "Bearer",
  });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    }),
  );
};

const sameSecret = (actual: string | undefined, expected: string): boolean => {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(actualBytes, expectedBytes)
  );
};

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Claude Code MCP host did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, HOST);
  });

const closeHttpServer = (
  server: http.Server,
  sockets: ReadonlySet<Socket>,
): Promise<void> =>
  new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
  });

/**
 * Creates one private MCP host for a Claude Code takeover session.
 *
 * The catalog is copied at creation and cannot change. Tool calls are handed
 * to the currently active turn, keeping Stella's existing execution policy,
 * hooks, lifecycle events, and side-effect tracking in the worker.
 */
export const createClaudeCodeToolMcpHost = async (
  options: CreateClaudeCodeToolMcpHostOptions,
): Promise<ClaudeCodeToolMcpHost> => {
  const tools = options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Detach nested schema objects from the mutable runtime catalog. Claude
    // must see exactly the allowlist captured when this session host started.
    inputSchema: structuredClone(tool.parameters),
  }));
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool.name || names.has(tool.name)) {
      throw new Error(
        tool.name
          ? `Duplicate Claude Code MCP tool: ${tool.name}`
          : "Claude Code MCP tools must have names",
      );
    }
    names.add(tool.name);
    if (tool.inputSchema.type !== "object") {
      throw new Error(
        `Claude Code MCP tool ${tool.name} must have an object JSON schema`,
      );
    }
  }

  const catalogHash = crypto
    .createHash("sha256")
    .update(stableJson(tools))
    .digest("hex");
  const bearer = `Bearer ${crypto.randomBytes(32).toString("base64url")}`;
  const endpointPath = `/mcp/${crypto.randomBytes(32).toString("base64url")}`;
  const activeCalls = new Set<AbortController>();
  // Streamable HTTP clients may retry a JSON-RPC request after losing its
  // response. Retain the original promise for the session so a successful
  // mutation is never executed twice under the same native request ID.
  const callLedger = new Map<string, Promise<CallToolResult>>();
  const responseDelivery = new AsyncLocalStorage<{
    acknowledgements: Set<() => void | Promise<void>>;
  }>();
  const settledCallLedgerKeys = new Set<string>();
  const trimCallLedger = () => {
    if (settledCallLedgerKeys.size <= MAX_SETTLED_CALL_LEDGER_ENTRIES) return;
    for (const key of callLedger.keys()) {
      if (!settledCallLedgerKeys.has(key)) continue;
      callLedger.delete(key);
      settledCallLedgerKeys.delete(key);
      if (settledCallLedgerKeys.size <= MAX_SETTLED_CALL_LEDGER_ENTRIES) break;
    }
  };

  const configureMcpServer = (mcpServer: Server) => {
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools,
    }));
    mcpServer.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        if (!names.has(request.params.name)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Tool is not available in this Stella session: ${request.params.name}`,
          );
        }
        const turn = options.getActiveTurn();
        const clientSessionId = extra.sessionId ?? "stateless";
        const durableScope = crypto
          .createHash("sha256")
          .update(turn?.identityScope ?? options.identityScope ?? "unscoped")
          .digest("hex")
          .slice(0, 24);
        const canonicalRequestHash = crypto
          .createHash("sha256")
          .update(request.params.name)
          .update("\0")
          .update(stableJson(request.params.arguments ?? {}))
          .digest("hex");
        const nativeToolUseId =
          request.params.name === "image_gen"
            ? await turn?.claimNativeToolUseId?.(
                request.params.name,
                request.params.arguments ?? {},
                extra.signal,
              )
            : undefined;
        if (request.params.name === "image_gen" && !nativeToolUseId) {
          throw new McpError(
            ErrorCode.InternalError,
            "Claude did not expose a durable tool_use identity for image_gen; refusing an unsafe submission.",
          );
        }
        const toolCallId = nativeToolUseId
          ? `claude:${durableScope}:${nativeToolUseId}:${canonicalRequestHash.slice(0, 24)}`
          : `mcp:${clientSessionId}:${String(extra.requestId)}`;
        const ledgerKey =
          request.params.name === "image_gen"
            ? `${durableScope}:${nativeToolUseId}:${request.params.name}:${canonicalRequestHash}`
            : `${clientSessionId}:${String(extra.requestId)}:${request.params.name}`;
        const registerDeliveryAcknowledgement = () => {
          if (request.params.name !== "image_gen") return;
          const acknowledgement = turn?.onToolResponseWritten;
          const delivery = responseDelivery.getStore();
          if (!acknowledgement || !delivery) return;
          delivery.acknowledgements.add(() =>
            acknowledgement({
              toolCallId,
              toolName: request.params.name,
            }),
          );
        };
        const previous = callLedger.get(ledgerKey);
        if (previous) {
          const result = await previous;
          registerDeliveryAcknowledgement();
          return result;
        }

        const execution = (async (): Promise<CallToolResult> => {
          if (!turn) {
            return {
              content: [
                {
                  type: "text",
                  text: "No Stella turn is active for this tool call.",
                },
              ],
              isError: true,
            };
          }

          const callAbort = new AbortController();
          activeCalls.add(callAbort);
          const forwardAbort = () => callAbort.abort();
          extra.signal.addEventListener("abort", forwardAbort, { once: true });
          if (extra.signal.aborted) forwardAbort();

          let progress = 0;
          const progressToken = request.params._meta?.progressToken;
          const onUpdate: ToolUpdateCallback = (update) => {
            turn.onToolUpdate?.({
              toolCallId,
              toolName: request.params.name,
              update,
            });
            if (progressToken !== undefined) {
              progress += 1;
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress,
                    message: summarizeUpdate(update),
                  },
                })
                .catch(() => undefined);
            }
          };

          try {
            const result = await turn.executeTool(
              toolCallId,
              request.params.name,
              request.params.arguments ?? {},
              callAbort.signal,
              onUpdate,
            );
            turn.onToolResult?.({
              toolCallId,
              toolName: request.params.name,
              result,
            });
            return await toolResultToMcp(result);
          } catch (error) {
            // A client cancellation already has its own MCP lifecycle; do not turn
            // it into a misleading model-visible tool failure.
            if (callAbort.signal.aborted) throw error;
            return {
              content: [
                {
                  type: "text",
                  text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
            };
          } finally {
            activeCalls.delete(callAbort);
            extra.signal.removeEventListener("abort", forwardAbort);
          }
        })();
        callLedger.set(ledgerKey, execution);
        void execution.then(
          () => {
            settledCallLedgerKeys.add(ledgerKey);
            trimCallLedger();
          },
          () => {
            settledCallLedgerKeys.add(ledgerKey);
            trimCallLedger();
          },
        );
        const result = await execution;
        registerDeliveryAcknowledgement();
        return result;
      },
    );
  };

  type McpClientSession = {
    server: Server;
    transport: StreamableHTTPServerTransport;
  };
  const clientSessions = new Map<string, McpClientSession>();
  const pendingSessions = new Set<McpClientSession>();
  const createClientSession = async (): Promise<McpClientSession> => {
    const server = new Server(
      { name: "stella-claude-code-tools", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    configureMcpServer(server);
    const state = {} as McpClientSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        pendingSessions.delete(state);
        clientSessions.set(sessionId, state);
      },
      onsessionclosed: (sessionId) => {
        clientSessions.delete(sessionId);
      },
    });
    state.server = server;
    state.transport = transport;
    pendingSessions.add(state);
    await server.connect(transport);
    return state;
  };

  const sockets = new Set<Socket>();
  let closed = false;
  const httpServer = http.createServer((request, response) => {
    if (request.url !== endpointPath) {
      response.writeHead(404).end();
      return;
    }
    if (!sameSecret(request.headers.authorization, bearer)) {
      unauthorized(response);
      return;
    }
    const sessionHeader = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;
    const handle = async () => {
      let state: McpClientSession | undefined;
      if (sessionId) {
        state = clientSessions.get(sessionId);
        if (!state) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "MCP session not found" },
              id: null,
            }),
          );
          return;
        }
      } else {
        // A fresh Claude process initializes a fresh MCP client session on the
        // same private host. This lets process/compaction recovery preserve
        // the immutable catalog URL without reusing stale transport state.
        state = await createClientSession();
      }
      const delivery = {
        acknowledgements: new Set<() => void | Promise<void>>(),
      };
      let responseFinished = false;
      response.once("finish", () => {
        responseFinished = true;
        for (const acknowledge of delivery.acknowledgements) {
          void Promise.resolve(acknowledge()).catch(() => undefined);
        }
        delivery.acknowledgements.clear();
      });
      response.once("close", () => {
        if (!responseFinished) delivery.acknowledgements.clear();
      });
      await responseDelivery.run(delivery, () =>
        state.transport.handleRequest(request, response),
      );
      if (!state.transport.sessionId) {
        pendingSessions.delete(state);
        await state.server.close().catch(() => undefined);
      }
    };
    void handle().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      if (!response.writableEnded) {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    });
  });
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  let port: number;
  try {
    port = await listen(httpServer);
  } catch (error) {
    throw error;
  }
  const url = `http://${HOST}:${port}${endpointPath}`;
  const abortActiveCalls = (reason?: unknown) => {
    for (const controller of activeCalls) controller.abort(reason);
  };
  const resetClientSessions = async (reason?: unknown) => {
    abortActiveCalls(
      reason ?? new Error("Claude Code MCP client sessions reset"),
    );
    const sessions = [...clientSessions.values(), ...pendingSessions.values()];
    clientSessions.clear();
    pendingSessions.clear();
    await Promise.allSettled(sessions.map((state) => state.server.close()));
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    const resetPromise = resetClientSessions(
      new Error("Claude Code MCP host closed"),
    );
    callLedger.clear();
    settledCallLedgerKeys.clear();
    // Tear down sockets concurrently: an in-flight HTTP call can otherwise
    // keep the protocol close waiting for the response it is itself aborting.
    await Promise.allSettled([
      resetPromise,
      closeHttpServer(httpServer, sockets),
    ]);
  };

  return {
    url,
    authorizationHeader: bearer,
    toolCatalogHash: catalogHash,
    mcpServerConfig: {
      type: "http",
      url,
      headers: { Authorization: bearer },
    },
    abortActiveCalls,
    resetClientSessions,
    close,
  };
};
