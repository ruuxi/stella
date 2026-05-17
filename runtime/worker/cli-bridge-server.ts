/**
 * Tiny Unix-socket RPC the worker exposes for sidecar CLIs (currently
 * just `stella-connect`) that need to call back into the host without
 * speaking the full host↔worker JSON-RPC protocol.
 *
 * Protocol: one connection = one request line of JSON, one response line
 * of JSON, server closes. Request: `{ id, method, params }`. Response:
 * `{ id, result }` on success or `{ id, error: { message } }` on failure.
 *
 * Surface is intentionally narrow. The only method today is
 * `connector.requestCredential` which forwards to the host's connector
 * credential broker. New methods get added as separate handler entries —
 * no introspection, no versioning, no streaming. If we ever need more
 * than this we should reconsider rather than grow the protocol here.
 */

import { promises as fsPromises } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";

type RequestMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
};

type ResponseMessage =
  | { id: string | number; result: unknown }
  | { id: string | number; error: { message: string } };

export type CliBridgeHandlers = {
  /**
   * Resolves with `{ ok: true }` once the credential is persisted on
   * disk, or `{ ok: false, reason }` when the user dismisses the dialog
   * or the host can't service the request.
   *
   * `authType: "oauth"` switches the host to the browser-based OAuth
   * flow (`connectConnectorOAuth`) and requires `resourceUrl` (the MCP
   * server URL — used for protected-resource metadata discovery). The
   * renderer shows a no-input "Connecting <X>... Authorize in the
   * browser tab Stella opened." indicator with Cancel; the host opens
   * the user's external browser via `shell.openExternal` and listens
   * on a local 127.0.0.1 callback port. Cancel aborts the listener.
   *
   * `authType: "api_key"` (or omitted) keeps the paste-key modal flow.
   */
  requestConnectorCredential: (params: {
    tokenKey: string;
    displayName: string;
    authType?: "api_key" | "oauth";
    resourceUrl?: string;
    oauthClientId?: string;
    oauthResource?: string;
    scopes?: string[];
    description?: string;
    placeholder?: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
};

export type CliBridgeServer = {
  socketPath: string;
  stop: () => Promise<void>;
};

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REQUEST_BYTES = 64 * 1024;

const writeResponse = (socket: Socket, response: ResponseMessage) => {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify(response)}\n`);
};

const handleConnection = (
  socket: Socket,
  handlers: CliBridgeHandlers,
  log: (message: string, error?: unknown) => void,
  activeSockets: Set<Socket>,
) => {
  activeSockets.add(socket);
  socket.on("close", () => activeSockets.delete(socket));

  let buffer = "";
  let resolved = false;
  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      writeResponse(socket, {
        id: 0,
        error: { message: "cli-bridge: request timed out before reading line" },
      });
    }
  }, REQUEST_TIMEOUT_MS);

  socket.setEncoding("utf-8");
  socket.on("data", (chunk: string) => {
    if (resolved) return;
    buffer += chunk;
    if (buffer.length > MAX_REQUEST_BYTES) {
      resolved = true;
      clearTimeout(timeout);
      writeResponse(socket, {
        id: 0,
        error: { message: "cli-bridge: request exceeded size limit" },
      });
      return;
    }
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex < 0) return;
    const line = buffer.slice(0, newlineIndex);
    resolved = true;
    clearTimeout(timeout);

    let request: RequestMessage;
    try {
      request = JSON.parse(line) as RequestMessage;
    } catch (error) {
      writeResponse(socket, {
        id: 0,
        error: {
          message: `cli-bridge: invalid JSON (${(error as Error).message})`,
        },
      });
      return;
    }
    const id = request.id ?? 0;
    const method = request.method;
    if (typeof method !== "string") {
      writeResponse(socket, {
        id,
        error: { message: "cli-bridge: missing method" },
      });
      return;
    }

    void (async () => {
      try {
        const result = await dispatch(method, request.params, handlers);
        writeResponse(socket, { id, result });
      } catch (error) {
        const message = (error as Error).message ?? "cli-bridge: handler threw";
        log(`handler ${method} threw`, error);
        writeResponse(socket, { id, error: { message } });
      }
    })();
  });
  socket.on("error", (error) => {
    log("socket error", error);
  });
};

const dispatch = async (
  method: string,
  params: unknown,
  handlers: CliBridgeHandlers,
): Promise<unknown> => {
  switch (method) {
    case "connector.requestCredential": {
      const record =
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : {};
      const tokenKey =
        typeof record.tokenKey === "string" ? record.tokenKey.trim() : "";
      if (!tokenKey) {
        throw new Error("connector.requestCredential: tokenKey is required");
      }
      const displayName =
        typeof record.displayName === "string" && record.displayName.trim()
          ? record.displayName.trim()
          : tokenKey;
      const authType =
        record.authType === "oauth" || record.authType === "api_key"
          ? record.authType
          : undefined;
      const resourceUrl =
        typeof record.resourceUrl === "string" && record.resourceUrl.trim()
          ? record.resourceUrl.trim()
          : undefined;
      const oauthClientId =
        typeof record.oauthClientId === "string" && record.oauthClientId.trim()
          ? record.oauthClientId.trim()
          : undefined;
      const oauthResource =
        typeof record.oauthResource === "string" && record.oauthResource.trim()
          ? record.oauthResource.trim()
          : undefined;
      const scopes = Array.isArray(record.scopes)
        ? record.scopes.filter(
            (scope): scope is string => typeof scope === "string",
          )
        : undefined;
      if (authType === "oauth" && !resourceUrl) {
        throw new Error(
          "connector.requestCredential: resourceUrl is required for authType=oauth",
        );
      }
      const description =
        typeof record.description === "string" ? record.description : undefined;
      const placeholder =
        typeof record.placeholder === "string" ? record.placeholder : undefined;
      return await handlers.requestConnectorCredential({
        tokenKey,
        displayName,
        authType,
        resourceUrl,
        oauthClientId,
        oauthResource,
        scopes,
        description,
        placeholder,
      });
    }
    default:
      throw new Error(`cli-bridge: unknown method "${method}"`);
  }
};

export const startCliBridgeServer = async ({
  socketPath,
  handlers,
  log = () => {},
}: {
  socketPath: string;
  handlers: CliBridgeHandlers;
  log?: (message: string, error?: unknown) => void;
}): Promise<CliBridgeServer> => {
  await fsPromises.mkdir(path.dirname(socketPath), { recursive: true });
  // Stale socket files from a crashed prior worker (or a leftover from a
  // graceful shutdown that didn't run) would block listen() with EADDRINUSE.
  await fsPromises.unlink(socketPath).catch(() => undefined);

  // Track live connections so `stop()` can tear them down rather than
  // waiting indefinitely for an in-flight credential round-trip to
  // complete. An accepted socket whose handler is awaiting the host
  // dialog can otherwise outlive the worker's intended shutdown window
  // (reset/reinit/app quit) because `server.close()` only stops
  // accepting new connections — it does not interrupt existing ones.
  const activeSockets = new Set<Socket>();

  const server: Server = createServer((socket) =>
    handleConnection(socket, handlers, log, activeSockets),
  );
  server.on("error", (error) => {
    log("server error", error);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  // 0o600 — readable/writable only by the owning user, matching the main
  // runtime socket's policy (`runtime/worker/transport.ts`). This path
  // pops the credential dialog and writes connector tokens on the user's
  // behalf, so anything weaker would let a same-host but different-uid
  // process trigger arbitrary credential prompts. `.catch(() => undefined)`
  // mirrors the main socket — on platforms where `chmod` on a unix socket
  // is a no-op (rare, but POSIX leaves it to the implementation), we'd
  // rather keep serving than refuse to start.
  await fsPromises.chmod(socketPath, 0o600).catch(() => undefined);

  return {
    socketPath,
    stop: () =>
      new Promise<void>((resolve) => {
        // Forcibly destroy any in-flight connections. Their handler
        // promises will settle on the next event-loop tick (the await
        // chain hits a destroyed socket / cancelled write) so `close()`
        // can fire its callback. We can't politely respond — the
        // host-side request may already be on its way back — but the
        // CLI side handles a closed-without-response as the same
        // "fall through to exit-2 auth_required" path it uses for any
        // other bridge failure.
        for (const socket of activeSockets) {
          socket.destroy();
        }
        activeSockets.clear();
        server.close(() => {
          void fsPromises.unlink(socketPath).catch(() => undefined);
          resolve();
        });
      }),
  };
};
