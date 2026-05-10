import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { attachJsonRpcPeerToStreams } from "../protocol/jsonl.js";
import {
  startOrAttachWorker,
  stopRunningWorker,
} from "../host/lifecycle.js";
import type { WorkerConnection } from "./worker-lifecycle.js";

/**
 * Production WorkerConnection factory: spawns or reattaches to the
 * detached UDS worker via `runtime/host/lifecycle.ts`, then wraps the
 * resulting Socket in a JsonRpcPeer plus a thin EventEmitter facade so
 * the existing `RuntimeWorkerLifecycleController` shape (which expects
 * `connection.process` to look like a `ChildProcessWithoutNullStreams`)
 * keeps working without any controller changes.
 *
 * The kill semantics are deliberately lenient: `process.kill()` on the
 * adapter just closes the socket. The worker self-shuts-down 10s after
 * the last client disconnect, so a clean Electron exit naturally
 * reaches "worker is gone" within 10s without a signal kill — and a
 * dirty Electron exit (crash) lets the worker keep running for the
 * next host to attach.
 *
 * `restart` callers that genuinely need a fresh worker call
 * `killUnderlyingWorker(stellaRoot)` directly.
 */

export type UdsWorkerConnectionFactoryOptions = {
  stellaRoot: string;
  bunBinaryPath?: string;
  idleShutdownMs?: number;
  expectedProtocolVersion?: string;
  hostExecutablePath?: string;
  env?: NodeJS.ProcessEnv;
  onError?: (error: unknown) => void;
};

const buildProcessShim = (
  socket: Socket,
  workerPid: number,
): WorkerConnection["process"] => {
  const emitter = new EventEmitter() as WorkerConnection["process"];

  // The lifecycle controller reads these directly.
  Object.assign(emitter, {
    pid: workerPid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: socket as unknown as WorkerConnection["process"]["stdin"],
    stdout: socket as unknown as WorkerConnection["process"]["stdout"],
    stderr: new EventEmitter() as unknown as WorkerConnection["process"]["stderr"],
  });

  // Calling .kill() on the adapter closes the socket — does NOT kill the
  // worker process. That is intentional: the UDS worker is detached and
  // self-supervises; if we want the worker dead we go through the
  // explicit lifecycle.killWorker() path.
  emitter.kill = ((_signal?: string): boolean => {
    try {
      socket.end();
      return true;
    } catch {
      return false;
    }
  }) as WorkerConnection["process"]["kill"];

  // ChildProcess types `exitCode` / `signalCode` as readonly. Our shim
  // assigns these via the same Object.assign-with-mutable-cast trick we
  // used during the initial setup so the lifecycle controller's
  // `connection.process.exitCode` reads work.
  const writableShim = emitter as unknown as {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  const markExited = (code: number | null, signal: NodeJS.Signals | null) => {
    if (writableShim.exitCode != null || writableShim.signalCode != null) return;
    writableShim.exitCode = code;
    writableShim.signalCode = signal;
    emitter.emit("exit", code, signal);
  };

  socket.once("close", () => markExited(0, null));
  socket.once("end", () => markExited(0, null));
  socket.once("error", () => markExited(1, null));

  return emitter;
};

/**
 * Returns a `createConnectionAsync` factory the lifecycle controller can
 * call. Each invocation either reuses an existing detached worker or
 * spawns a new one, then returns a connection wired to the JSON-RPC peer.
 */
export const buildUdsConnectionFactory = (
  options: UdsWorkerConnectionFactoryOptions,
) => {
  return async (workerEntryPath: string): Promise<WorkerConnection> => {
    const lifecycle = await startOrAttachWorker({
      stellaRoot: options.stellaRoot,
      workerEntryPath,
      ...(options.bunBinaryPath ? { bunBinaryPath: options.bunBinaryPath } : {}),
      ...(options.idleShutdownMs
        ? { idleShutdownMs: options.idleShutdownMs }
        : {}),
      ...(options.expectedProtocolVersion
        ? { expectedProtocolVersion: options.expectedProtocolVersion }
        : {}),
      ...(options.hostExecutablePath
        ? { hostExecutablePath: options.hostExecutablePath }
        : {}),
      env: options.env ?? {},
    });

    const { peer } = attachJsonRpcPeerToStreams({
      input: lifecycle.socket,
      output: lifecycle.socket,
      onError: options.onError ?? ((error) => {
        console.error("[runtime-client] worker RPC error:", error);
      }),
    });

    return {
      process: buildProcessShim(lifecycle.socket, lifecycle.pid),
      peer,
      pid: lifecycle.pid,
    };
  };
};

/**
 * Explicit kill path — used by restart-relevant flows (runtime code
 * reload, user-triggered "Restart Stella runtime"). Does NOT touch the
 * connection; the controller's stop("restart") does that separately.
 */
export const killDetachedWorker = async (
  stellaRoot: string,
): Promise<void> => {
  await stopRunningWorker(stellaRoot, { graceMs: 1_500 });
};
