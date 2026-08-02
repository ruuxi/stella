/**
 * Private local RPC for the bundled `stella-connect` CLI.
 *
 * The surface is intentionally closed: connector actions, Store connect-card
 * requests, and desktop permission checks. It does not expose credentials,
 * tokens, arbitrary URLs, or imported connector transports.
 */

import { constants as fsConstants, promises as fsPromises } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import type {
  BackendConnectorActionResult,
  BackendConnectorActionsResult,
} from "../kernel/connectors/cli-broker-client.js";
import { runtimeIpcPathUsesFilesystem } from "./runtime-paths.js";

type RequestMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
};

type ResponseMessage =
  | { id: string | number; result: unknown }
  | { id: string | number; error: { message: string } };

export type CliBridgeHandlers = {
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
  listBackendConnectorActions?: (params: {
    connectorId: string;
    query?: string;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }) => Promise<BackendConnectorActionsResult>;
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
    case "connector.listBackendActions": {
      if (!handlers.listBackendConnectorActions) {
        return { ok: false, reason: "unsupported" };
      }
      const record =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      const allowedKeys = new Set([
        "connectorId",
        "query",
        "cursor",
        "limit",
      ]);
      if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
        throw new Error(
          "connector.listBackendActions: arbitrary fields are not allowed",
        );
      }
      const connectorId =
        typeof record.connectorId === "string"
          ? record.connectorId.trim().toLowerCase()
          : "";
      if (!connectorId) {
        throw new Error(
          "connector.listBackendActions: connectorId is required",
        );
      }
      const query =
        typeof record.query === "string" && record.query.trim()
          ? record.query.trim()
          : undefined;
      const cursor =
        typeof record.cursor === "string" && record.cursor.trim()
          ? record.cursor.trim()
          : undefined;
      const limit =
        typeof record.limit === "number" ? record.limit : undefined;
      return await handlers.listBackendConnectorActions({
        connectorId,
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(signal ? { signal } : {}),
      });
    }
    case "connector.requestConnection": {
      if (!handlers.requestConnectorConnection) {
        return { ok: false, reason: "unsupported" };
      }
      const record =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      const allowedKeys = new Set([
        "id",
        "name",
        "description",
        "iconUrl",
        "category",
        "reason",
      ]);
      if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
        throw new Error(
          "connector.requestConnection: arbitrary fields are not allowed",
        );
      }
      const id =
        typeof record.id === "string" ? record.id.trim().toLowerCase() : "";
      if (!id) throw new Error("connector.requestConnection: id is required");
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
    case "system.requestPermission": {
      if (!handlers.requestDesktopPermission) {
        return { ok: false, reason: "unsupported" };
      }
      const record =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {};
      if (Object.keys(record).some((key) => key !== "kind")) {
        throw new Error(
          "system.requestPermission: arbitrary fields are not allowed",
        );
      }
      const kind = typeof record.kind === "string" ? record.kind : "";
      if (kind !== "accessibility" && kind !== "screen") {
        throw new Error(
          "system.requestPermission: unsupported permission kind",
        );
      }
      return await handlers.requestDesktopPermission({ kind });
    }
    default:
      throw new Error(`cli-bridge: unknown method "${method}"`);
  }
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
    if (resolved) return;
    resolved = true;
    writeResponse(socket, {
      id: 0,
      error: { message: "cli-bridge: request timed out before reading line" },
    });
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
    if (typeof request.method !== "string") {
      writeResponse(socket, {
        id,
        error: { message: "cli-bridge: missing method" },
      });
      return;
    }
    void dispatch(
      request.method,
      request.params,
      handlers,
      connectionAbort.signal,
    )
      .then((result) => writeResponse(socket, { id, result }))
      .catch((error) => {
        const message = (error as Error).message ?? "cli-bridge: handler threw";
        log(`handler ${request.method} threw`, error);
        writeResponse(socket, { id, error: { message } });
      });
  });
  socket.on("error", (error) => log("socket error", error));
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
  if (!runtimeIpcPathUsesFilesystem(socketPath)) {
    throw new Error(
      "cli-bridge: secure current-user named-pipe ACLs are unavailable in this runtime",
    );
  }
  const socketDir = path.dirname(socketPath);
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
      throw new Error("cli-bridge: refusing to replace an unsafe stale socket path");
    }
    await fsPromises.unlink(socketPath);
  }

  const activeSockets = new Set<Socket>();
  let acceptingRequests = false;
  const server: Server = createServer((socket) => {
    if (!acceptingRequests) {
      socket.destroy();
      return;
    }
    handleConnection(socket, handlers, log, activeSockets);
  });
  server.on("error", (error) => log("server error", error));

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
        for (const socket of activeSockets) socket.destroy();
        activeSockets.clear();
        server.close(() => {
          void fsPromises
            .unlink(socketPath)
            .catch(() => undefined)
            .then(() => fsPromises.rmdir(socketDir).catch(() => undefined));
          resolve();
        });
      }),
  };
};
