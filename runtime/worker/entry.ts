import { WorkerPeerBroker } from "./peer-broker.js";
import { createRuntimeWorkerServer } from "./server.js";
import {
  parseWorkerArgs,
  parseWorkerListenUrl,
  startWorkerTransport,
  type WorkerTransport,
} from "./transport.js";
import {
  WorkerLifecycleServer,
  removeStaleRuntimeArtifacts,
} from "./lifecycle-server.js";

/**
 * Worker entrypoint. Two execution modes:
 *
 *   bun run runtime/worker/entry.js
 *     -> default stdio mode. Parent process owns the worker; lifecycle is
 *        tied to stdin/stdout. Used by tests, by the legacy embedded
 *        worker codepath, and by the host adapter when the lifecycle
 *        manager spawns the worker as a regular child process.
 *
 *   bun run runtime/worker/entry.js --listen unix:///path/to/runtime.sock
 *     -> detached mode. The worker binds the socket, writes pid+lock to
 *        ~/.stella/runtime/<rootHash>/, and self-shuts-down 10s after
 *        the last client disconnect. The host attaches over UDS instead
 *        of stdio, so Electron restart drops the connection without
 *        killing the worker.
 *
 *   ... --stella-root /path                    [required for unix mode]
 *   ... --idle-shutdown-ms 10000               [unix mode only]
 */

type ParsedArgs = {
  listenUrl: string;
  stellaRoot: string | null;
  idleShutdownMs: number | null;
};

const parseEntryArgs = (argv: string[]): ParsedArgs => {
  let listenUrl = "stdio://";
  let stellaRoot: string | null = null;
  let idleShutdownMs: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--listen" && i + 1 < argv.length) {
      listenUrl = argv[i + 1] ?? listenUrl;
      i += 1;
    } else if (arg.startsWith("--listen=")) {
      listenUrl = arg.slice("--listen=".length);
    } else if (arg === "--stella-root" && i + 1 < argv.length) {
      stellaRoot = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--stella-root=")) {
      stellaRoot = arg.slice("--stella-root=".length);
    } else if (arg === "--idle-shutdown-ms" && i + 1 < argv.length) {
      const next = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(next) && next > 0) idleShutdownMs = next;
      i += 1;
    } else if (arg.startsWith("--idle-shutdown-ms=")) {
      const next = Number.parseInt(arg.slice("--idle-shutdown-ms=".length), 10);
      if (Number.isFinite(next) && next > 0) idleShutdownMs = next;
    }
  }
  return { listenUrl, stellaRoot, idleShutdownMs };
};

const main = async () => {
  const cliArgs = parseEntryArgs(process.argv.slice(2));
  const transportResult = parseWorkerListenUrl(cliArgs.listenUrl);
  if (!transportResult.ok) {
    console.error(`[runtime-worker] ${transportResult.error}`);
    process.exit(2);
  }
  const transport = transportResult.transport;

  const broker = new WorkerPeerBroker();
  const runtimeServer = createRuntimeWorkerServer(broker);

  let lifecycle: WorkerLifecycleServer | null = null;
  let detachedMode = false;
  if (transport.kind === "unix") {
    if (!cliArgs.stellaRoot) {
      console.error(
        "[runtime-worker] --listen unix://... requires --stella-root <path>",
      );
      process.exit(2);
    }
    detachedMode = true;
    lifecycle = new WorkerLifecycleServer({
      stellaRoot: cliArgs.stellaRoot,
      ...(cliArgs.idleShutdownMs ? { idleShutdownMs: cliArgs.idleShutdownMs } : {}),
      shouldKeepAlive: () => runtimeServer.hasActiveWork(),
      onShutdown: async () => {
        broker.dispose();
      },
    });
    try {
      await lifecycle.start();
    } catch (error) {
      console.error(
        `[runtime-worker] Failed to acquire lifecycle lock: ${(error as Error).message}`,
      );
      process.exit(3);
    }
  }

  if (lifecycle) {
    broker.on("client-attached", () => lifecycle?.noteClientConnected());
    broker.on("client-detached", () => {
      lifecycle?.noteClientDisconnected();
    });
  }

  const server = await startWorkerTransport({
    transport,
    broker,
    onError: (error) => {
      console.error("[runtime-worker] transport error:", error);
    },
  });

  if (detachedMode) {
    console.error(
      `[runtime-worker] listening on ${server.describe()} (pid=${process.pid})`,
    );
  }

  const shutdown = async (signal: string) => {
    try {
      await server.close();
    } catch {
      // Best effort.
    }
    if (lifecycle) {
      await lifecycle.shutdown("signal");
    } else {
      broker.dispose();
    }
    process.exit(signal === "SIGTERM" ? 0 : 0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGHUP", () => void shutdown("SIGHUP"));
};

void main().catch((error) => {
  console.error("[runtime-worker] fatal:", error);
  process.exit(1);
});

export {
  // Re-exports for tests / external callers.
  WorkerPeerBroker,
  parseWorkerListenUrl,
  parseWorkerArgs,
  startWorkerTransport,
  removeStaleRuntimeArtifacts,
};
export type { WorkerTransport };
