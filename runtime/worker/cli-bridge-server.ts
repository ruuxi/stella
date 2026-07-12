/**
 * Tiny local-IPC RPC the worker exposes for sidecar CLIs (currently just
 * `stella-connect`) that need to call back into the host without speaking
 * the full host↔worker JSON-RPC protocol.
 *
 * Protocol: one connection = one request line of JSON, one response line
 * of JSON, server closes. Request: `{ id, method, params }`. Response:
 * `{ id, result }` on success or `{ id, error: { message } }` on failure.
 *
 * Surface is intentionally narrow. Connector backend actions are brokered as
 * action-specific requests; the protocol never exposes Stella site auth or an
 * arbitrary HTTP proxy. New methods get added as separate handler entries —
 * no introspection, no versioning, no streaming. If we ever need more
 * than this we should reconsider rather than grow the protocol here.
 */

import { constants as fsConstants, promises as fsPromises } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { runtimeIpcPathUsesFilesystem } from "./runtime-paths.js";
import type { BackendConnectorActionResult } from "../kernel/connectors/cli-broker-client.js";

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
    preregisteredOAuth?: {
      clientId: string;
      authorizationEndpoint: string;
      tokenEndpoint?: string;
      responseType?: "code" | "token";
      resourceUrl?: string;
      oauthResource?: string | null;
      callbackUrl?: string;
      callbackId?: string;
      callbackMode?: "local" | "external";
      scopeSeparator?: string;
      usesPkce?: boolean;
      authorizationRedirectParam?: string;
      authorizationParams?: Record<string, string>;
      tokenRedirectParam?: string;
      tokenAuth?: "body" | "basic";
      tokenExchange?: {
        type: "backend";
        provider: string;
      };
    };
    description?: string;
    placeholder?: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
  /**
   * Show an inline connect card in the active chat offering to connect
   * a native Store integration. Resolves once the user accepts and the
   * host finishes the enable + OAuth flow (`{ ok: true }`), or when the
   * user declines / the card times out (`{ ok: false, reason }`).
   */
  requestConnectorConnection?: (params: {
    id: string;
    name: string;
    description?: string;
    iconUrl?: string;
    category?: string;
    reason?: string;
  }) => Promise<
    | { ok: true; status: "connected" | "already_connected" }
    | {
        ok: false;
        reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
      }
  >;
  runBackendConnectorAction?: (params: {
    connectorId: string;
    action: string;
    input: Record<string, unknown>;
    requestId?: string;
    signal?: AbortSignal;
  }) => Promise<BackendConnectorActionResult>;
  requestDesktopPermission?: (params: {
    kind: "accessibility" | "screen";
  }) =>
    | Promise<
        | { ok: true; granted: boolean; alreadyGranted: boolean }
        | { ok: false; reason: string }
      >
    | { ok: true; granted: boolean; alreadyGranted: boolean }
    | { ok: false; reason: string };
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
  const connectionAbort = new AbortController();
  activeSockets.add(socket);
  socket.on("close", () => {
    activeSockets.delete(socket);
    connectionAbort.abort("cli_disconnected");
  });

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
        const result = await dispatch(
          method,
          request.params,
          handlers,
          connectionAbort.signal,
        );
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
  signal?: AbortSignal,
): Promise<unknown> => {
  switch (method) {
    case "connector.runBackendAction": {
      if (!handlers.runBackendConnectorAction) {
        return { ok: false, reason: "unsupported" };
      }
      const record =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      const allowedKeys = new Set([
        "connectorId",
        "action",
        "input",
        "requestId",
      ]);
      if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
        throw new Error(
          "connector.runBackendAction: arbitrary transport fields are not allowed",
        );
      }
      const connectorId =
        typeof record.connectorId === "string"
          ? record.connectorId.trim().toLowerCase()
          : "";
      const action =
        typeof record.action === "string" ? record.action.trim() : "";
      const input =
        record.input &&
        typeof record.input === "object" &&
        !Array.isArray(record.input)
          ? (record.input as Record<string, unknown>)
          : null;
      const requestId =
        typeof record.requestId === "string" && record.requestId.trim()
          ? record.requestId.trim()
          : undefined;
      if (!connectorId || !action || !input) {
        throw new Error(
          "connector.runBackendAction: connectorId, action, and object input are required",
        );
      }
      return await handlers.runBackendConnectorAction({
        connectorId,
        action,
        input,
        ...(requestId ? { requestId } : {}),
        ...(signal ? { signal } : {}),
      });
    }
    case "system.requestPermission": {
      if (!handlers.requestDesktopPermission) {
        return { ok: false, reason: "unsupported" };
      }
      const record =
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : {};
      const kind = typeof record.kind === "string" ? record.kind : "";
      if (kind !== "accessibility" && kind !== "screen") {
        throw new Error(
          "system.requestPermission: unsupported permission kind",
        );
      }
      return await handlers.requestDesktopPermission({ kind });
    }
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
      const preregisteredOAuth =
        record.preregisteredOAuth &&
        typeof record.preregisteredOAuth === "object"
          ? (record.preregisteredOAuth as Record<string, unknown>)
          : null;
      const authorizationParams =
        preregisteredOAuth?.authorizationParams &&
        typeof preregisteredOAuth.authorizationParams === "object" &&
        !Array.isArray(preregisteredOAuth.authorizationParams)
          ? Object.fromEntries(
              Object.entries(
                preregisteredOAuth.authorizationParams as Record<
                  string,
                  unknown
                >,
              ).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === "string" && typeof entry[1] === "string",
              ),
            )
          : null;
      const normalizedPreregisteredOAuth =
        preregisteredOAuth &&
        typeof preregisteredOAuth.clientId === "string" &&
        preregisteredOAuth.clientId.trim() &&
        typeof preregisteredOAuth.authorizationEndpoint === "string" &&
        preregisteredOAuth.authorizationEndpoint.trim()
          ? {
              clientId: preregisteredOAuth.clientId.trim(),
              authorizationEndpoint:
                preregisteredOAuth.authorizationEndpoint.trim(),
              ...(typeof preregisteredOAuth.tokenEndpoint === "string" &&
              preregisteredOAuth.tokenEndpoint.trim()
                ? { tokenEndpoint: preregisteredOAuth.tokenEndpoint.trim() }
                : {}),
              ...(preregisteredOAuth.responseType === "token"
                ? { responseType: "token" as const }
                : {}),
              ...(typeof preregisteredOAuth.resourceUrl === "string" &&
              preregisteredOAuth.resourceUrl.trim()
                ? { resourceUrl: preregisteredOAuth.resourceUrl.trim() }
                : {}),
              ...(typeof preregisteredOAuth.oauthResource === "string"
                ? { oauthResource: preregisteredOAuth.oauthResource }
                : preregisteredOAuth.oauthResource === null
                  ? { oauthResource: null }
                  : {}),
              ...(typeof preregisteredOAuth.callbackUrl === "string" &&
              preregisteredOAuth.callbackUrl.trim()
                ? { callbackUrl: preregisteredOAuth.callbackUrl.trim() }
                : {}),
              ...(typeof preregisteredOAuth.callbackId === "string" &&
              preregisteredOAuth.callbackId.trim()
                ? { callbackId: preregisteredOAuth.callbackId.trim() }
                : {}),
              ...(preregisteredOAuth.callbackMode === "external"
                ? { callbackMode: "external" as const }
                : preregisteredOAuth.callbackMode === "local"
                  ? { callbackMode: "local" as const }
                  : {}),
              ...(typeof preregisteredOAuth.scopeSeparator === "string"
                ? { scopeSeparator: preregisteredOAuth.scopeSeparator }
                : {}),
              ...(typeof preregisteredOAuth.usesPkce === "boolean"
                ? { usesPkce: preregisteredOAuth.usesPkce }
                : {}),
              ...(typeof preregisteredOAuth.authorizationRedirectParam ===
              "string"
                ? {
                    authorizationRedirectParam:
                      preregisteredOAuth.authorizationRedirectParam,
                  }
                : {}),
              ...(authorizationParams && Object.keys(authorizationParams).length
                ? {
                    authorizationParams,
                  }
                : {}),
              ...(typeof preregisteredOAuth.tokenRedirectParam === "string"
                ? { tokenRedirectParam: preregisteredOAuth.tokenRedirectParam }
                : {}),
              ...(preregisteredOAuth.tokenAuth === "basic"
                ? { tokenAuth: "basic" as const }
                : preregisteredOAuth.tokenAuth === "body"
                  ? { tokenAuth: "body" as const }
                  : {}),
              ...(preregisteredOAuth.tokenExchange &&
              typeof preregisteredOAuth.tokenExchange === "object" &&
              (preregisteredOAuth.tokenExchange as Record<string, unknown>)
                .type === "backend" &&
              typeof (
                preregisteredOAuth.tokenExchange as Record<string, unknown>
              ).provider === "string"
                ? {
                    tokenExchange: {
                      type: "backend" as const,
                      provider: (
                        preregisteredOAuth.tokenExchange as Record<
                          string,
                          string
                        >
                      ).provider,
                    },
                  }
                : {}),
            }
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
        preregisteredOAuth: normalizedPreregisteredOAuth,
        description,
        placeholder,
      });
    }
    case "connector.requestConnection": {
      if (!handlers.requestConnectorConnection) {
        return { ok: false, reason: "unsupported" };
      }
      const record =
        params && typeof params === "object"
          ? (params as Record<string, unknown>)
          : {};
      const id =
        typeof record.id === "string" ? record.id.trim().toLowerCase() : "";
      if (!id) {
        throw new Error("connector.requestConnection: id is required");
      }
      const name =
        typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : id;
      const readOptional = (key: string) =>
        typeof record[key] === "string" && (record[key] as string).trim()
          ? (record[key] as string).trim()
          : undefined;
      return await handlers.requestConnectorConnection({
        id,
        name,
        description: readOptional("description"),
        iconUrl: readOptional("iconUrl"),
        category: readOptional("category"),
        reason: readOptional("reason"),
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
  const usesFilesystem = runtimeIpcPathUsesFilesystem(socketPath);
  if (!usesFilesystem) {
    throw new Error(
      "cli-bridge: secure current-user named-pipe ACLs are unavailable in this runtime",
    );
  }
  const socketDir = path.dirname(socketPath);
  if (usesFilesystem) {
    await fsPromises.mkdir(socketDir, { recursive: true, mode: 0o700 });
    const currentUid =
      typeof process.getuid === "function" ? process.getuid() : null;
    const initialDirectoryStat = await fsPromises.lstat(socketDir);
    if (
      initialDirectoryStat.isSymbolicLink() ||
      !initialDirectoryStat.isDirectory() ||
      (currentUid !== null && initialDirectoryStat.uid !== currentUid)
    ) {
      throw new Error(
        "cli-bridge: socket directory is not private and owned by the current user",
      );
    }
    const directoryHandle = await fsPromises.open(
      socketDir,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
    let directoryStat;
    try {
      await directoryHandle.chmod(0o700);
      directoryStat = await directoryHandle.stat();
    } finally {
      await directoryHandle.close();
    }
    if (
      !directoryStat.isDirectory() ||
      (currentUid !== null && directoryStat.uid !== currentUid) ||
      (directoryStat.mode & 0o077) !== 0
    ) {
      throw new Error(
        "cli-bridge: socket directory is not private and owned by the current user",
      );
    }
    const staleStat = await fsPromises.lstat(socketPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (staleStat) {
      if (
        staleStat.isSymbolicLink() ||
        !staleStat.isSocket() ||
        (currentUid !== null && staleStat.uid !== currentUid)
      ) {
        throw new Error(
          "cli-bridge: refusing to replace an unsafe stale socket path",
        );
      }
      await fsPromises.unlink(socketPath);
    }
  }

  // Track live connections so `stop()` can tear them down rather than
  // waiting indefinitely for an in-flight credential round-trip to
  // complete. An accepted socket whose handler is awaiting the host
  // dialog can otherwise outlive the worker's intended shutdown window
  // (reset/reinit/app quit) because `server.close()` only stops
  // accepting new connections — it does not interrupt existing ones.
  const activeSockets = new Set<Socket>();

  let acceptingRequests = false;
  const server: Server = createServer((socket) => {
    if (!acceptingRequests) {
      socket.destroy();
      return;
    }
    handleConnection(socket, handlers, log, activeSockets);
  });
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

  try {
    await fsPromises.chmod(socketPath, 0o600);
    const socketStat = await fsPromises.lstat(socketPath);
    const currentUid =
      typeof process.getuid === "function" ? process.getuid() : null;
    if (
      socketStat.isSymbolicLink() ||
      !socketStat.isSocket() ||
      (currentUid !== null && socketStat.uid !== currentUid) ||
      (socketStat.mode & 0o177) !== 0
    ) {
      throw new Error("cli-bridge: socket permissions could not be secured");
    }
    acceptingRequests = true;
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsPromises.unlink(socketPath).catch(() => undefined);
    await fsPromises.rmdir(socketDir).catch(() => undefined);
    throw error;
  }

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
          if (usesFilesystem) {
            void fsPromises
              .unlink(socketPath)
              .catch(() => undefined)
              .then(() => fsPromises.rmdir(socketDir).catch(() => undefined));
          }
          resolve();
        });
      }),
  };
};
