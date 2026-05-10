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

/**
 * Worker transport selection. The runtime worker can listen on:
 *
 *   --listen stdio://         (default, parent-spawned-child topology)
 *   --listen unix://PATH      (detached topology, host attaches via UDS)
 *
 * Both share the same JSON-RPC protocol — only the byte stream changes.
 * Inspired by codex's `app-server-transport` enum (`AppServerTransport`).
 *
 * Stdio mode supports a single connection over stdin/stdout for the lifetime
 * of the process; UDS mode accepts an arbitrary number of sequential or
 * concurrent connections, which is what makes survival-across-host-restart
 * possible.
 */

export type WorkerTransport =
  | { kind: "stdio" }
  | { kind: "unix"; socketPath: string };

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
  return {
    ok: false,
    error: `Unsupported --listen URL: ${listenUrl}; expected stdio:// or unix://PATH.`,
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
  /** Whichever socket address the listener bound to (UDS path for unix, "stdio" for stdio). */
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
  if (!existsSync(socketPath)) return;
  const liveSocket = await new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
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
  await fsPromises.unlink(socketPath).catch(() => undefined);
};

const startUnixSocketTransport = async (
  args: StartTransportArgs & { transport: { kind: "unix"; socketPath: string } },
): Promise<StartTransportResult> => {
  const { socketPath } = args.transport;
  await fsPromises.mkdir(path.dirname(socketPath), { recursive: true });
  await removeIfStaleSocket(socketPath);

  const server: Server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
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

  // 0o600 — readable/writable only by the owning user.
  await fsPromises.chmod(socketPath, 0o600).catch(() => undefined);

  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await fsPromises.unlink(socketPath).catch(() => undefined);
    },
    describe: () => `unix://${socketPath}`,
  };
};

export const startWorkerTransport = async (
  args: StartTransportArgs,
): Promise<StartTransportResult> => {
  if (args.transport.kind === "stdio") {
    return startStdioTransport(args);
  }
  return await startUnixSocketTransport({
    ...args,
    transport: args.transport,
  });
};
