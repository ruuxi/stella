import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { PassThrough } from "node:stream";
import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { attachJsonRpcPeerToStreams } from "../protocol/jsonl.js";
import {
  STELLA_RUNTIME_PROTOCOL_VERSION,
  STELLA_RUNTIME_READY_METHOD,
  type JsonRpcMessage,
} from "../protocol/index.js";
import type { WorkerPeerBroker } from "./peer-broker.js";
import {
  isWindowsNamedPipePath,
  runtimeIpcPathUsesFilesystem,
} from "./runtime-paths.js";

/**
 * Worker transport selection. The runtime worker can listen on:
 *
 *   --listen stdio://         (default, parent-spawned-child topology)
 *   --listen unix://PATH      (detached topology, host attaches via Unix socket)
 *   --listen pipe://PIPE      (detached topology, host attaches via Windows named pipe)
 *
 * Both share the same JSON-RPC protocol — only the byte stream changes.
 * Shared worker transport names for Stella app-server connections.
 *
 * Stdio mode supports a single connection over stdin/stdout for the lifetime
 * of the process; IPC-listener mode accepts an arbitrary number of sequential
 * or concurrent connections, which is what makes survival-across-host-restart
 * possible.
 */

export type WorkerTransport =
  | { kind: "stdio" }
  | { kind: "unix"; socketPath: string }
  | { kind: "pipe"; socketPath: string };

export type WorkerTransportParseResult =
  | { ok: true; transport: WorkerTransport }
  | { ok: false; error: string };

export const DEFAULT_LISTEN_URL = "stdio://";

export const parseWorkerListenUrl = (
  listenUrl: string,
): WorkerTransportParseResult => {
  const normalized = listenUrl.trim();
  if (!normalized || normalized === DEFAULT_LISTEN_URL) {
    return { ok: true, transport: { kind: "stdio" } };
  }
  if (normalized.startsWith("unix://")) {
    const socketPath = normalized.slice("unix://".length).trim();
    if (!socketPath) {
      return {
        ok: false,
        error: "Missing socket path: --listen unix://PATH requires a path.",
      };
    }
    return {
      ok: true,
      transport: { kind: "unix", socketPath: path.resolve(socketPath) },
    };
  }
  if (normalized.startsWith("pipe://")) {
    const socketPath = normalized.slice("pipe://".length).trim();
    if (!socketPath) {
      return {
        ok: false,
        error: "Missing pipe path: --listen pipe://PIPE requires a path.",
      };
    }
    if (!isWindowsNamedPipePath(socketPath)) {
      return {
        ok: false,
        error:
          "Invalid Windows named pipe: --listen pipe://... expects \\\\.\\pipe\\NAME.",
      };
    }
    return {
      ok: true,
      transport: { kind: "pipe", socketPath },
    };
  }
  return {
    ok: false,
    error: `Unsupported --listen URL: ${listenUrl}; expected stdio://, unix://PATH, or pipe://PIPE.`,
  };
};

export const parseWorkerArgs = (
  argv: string[],
): { listenUrl: string } => {
  let listenUrl = DEFAULT_LISTEN_URL;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--listen" && i + 1 < argv.length) {
      listenUrl = argv[i + 1] ?? DEFAULT_LISTEN_URL;
      i += 1;
    } else if (arg?.startsWith("--listen=")) {
      listenUrl = arg.slice("--listen=".length);
    }
  }
  return { listenUrl };
};

export type StartTransportArgs = {
  transport: WorkerTransport;
  broker: WorkerPeerBroker;
  onError?: (error: unknown) => void;
};

export type StartTransportResult = {
  /** Stop accepting new connections and close the listener. */
  close: () => Promise<void>;
  /** Whichever socket address the listener bound to (IPC path for detached mode, "stdio" for stdio). */
  describe: () => string;
};

const startStdioTransport = (
  args: StartTransportArgs,
): StartTransportResult => {
  const handle = attachJsonRpcPeerToStreams({
    input: process.stdin,
    output: process.stdout,
    onError: args.onError,
  });
  args.broker.attach(handle.peer);
  return {
    close: async () => {
      handle.dispose();
    },
    describe: () => "stdio",
  };
};

const removeIfStaleSocket = async (socketPath: string) => {
  const usesFilesystem = runtimeIpcPathUsesFilesystem(socketPath);
  if (usesFilesystem && !existsSync(socketPath)) return;
  const liveSocket = await new Promise<boolean>((resolve) => {
    let socket: Socket;
    try {
      socket = createConnection(socketPath);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), 250);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
  if (liveSocket) {
    throw new Error(`Runtime socket is already in use: ${socketPath}`);
  }
  // Best-effort cleanup for crashed workers that left a dead socket file.
  if (usesFilesystem) {
    await fsPromises.unlink(socketPath).catch(() => undefined);
  }
};

const startIpcSocketTransport = async (
  args: StartTransportArgs & {
    transport:
      | { kind: "unix"; socketPath: string }
      | { kind: "pipe"; socketPath: string };
  },
): Promise<StartTransportResult> => {
  const { socketPath } = args.transport;
  const usesFilesystem = runtimeIpcPathUsesFilesystem(socketPath);
  if (usesFilesystem) {
    await fsPromises.mkdir(path.dirname(socketPath), { recursive: true });
  }
  await removeIfStaleSocket(socketPath);

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    socket.on("error", () => {
      // Connection-level errors (e.g. host crashed) just close the socket;
      // peer.dispose runs via the readline 'close' handler downstream.
    });

    let buffered = "";
    let attached = false;
    const attachSocket = (initialInput: string) => {
      if (attached) return;
      attached = true;
      socket.off("data", onFirstData);
      const input = new PassThrough();
      if (initialInput) {
        input.write(initialInput);
      }
      socket.pipe(input);
      const handle = attachJsonRpcPeerToStreams({
        input,
        output: socket,
        onError: args.onError,
      });
      args.broker.attach(handle.peer);
      socket.resume();
    };
    const onFirstData = (chunk: Buffer) => {
      buffered += chunk.toString("utf-8");
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex < 0) {
        // Do not let a malformed probe/client accumulate unbounded data before
        // the first JSON-RPC line.
        if (buffered.length > 64 * 1024) {
          attachSocket(buffered);
        }
        return;
      }
      const firstLine = buffered.slice(0, newlineIndex).trim();
      if (firstLine) {
        try {
          const message = JSON.parse(firstLine) as JsonRpcMessage;
          if (
            "method" in message &&
            "id" in message &&
            message.method === STELLA_RUNTIME_READY_METHOD
          ) {
            socket.write(
              `${JSON.stringify({
                id: message.id,
                result: { ok: true, protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION },
              })}\n`,
              () => socket.end(),
            );
            return;
          }
        } catch {
          // Fall through to the normal JSON-RPC parser so it reports the
          // parse error consistently.
        }
      }
      socket.pause();
      attachSocket(buffered);
    };
    socket.on("data", onFirstData);
  });

  server.on("error", (error) => {
    args.onError?.(error);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  if (usesFilesystem) {
    // 0o600 — readable/writable only by the owning user.
    await fsPromises.chmod(socketPath, 0o600).catch(() => undefined);
  }

  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) {
          socket.destroy();
        }
      });
      if (usesFilesystem) {
        await fsPromises.unlink(socketPath).catch(() => undefined);
      }
    },
    describe: () => `${args.transport.kind}://${socketPath}`,
  };
};

export const startWorkerTransport = async (
  args: StartTransportArgs,
): Promise<StartTransportResult> => {
  if (args.transport.kind === "stdio") {
    return startStdioTransport(args);
  }
  return await startIpcSocketTransport({
    ...args,
    transport: args.transport,
  });
};
