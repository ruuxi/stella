import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  createRuntimeUnavailableError,
  type JsonRpcPeer,
} from "../protocol/rpc-peer.js";
import type {
  AgentHealth,
  RuntimeActiveRun,
  SocialSessionServiceSnapshot,
} from "../protocol/index.js";

export type WorkerConnection = {
  process: ChildProcessWithoutNullStreams;
  peer: JsonRpcPeer;
  pid: number;
};

export type WorkerLifecycleState = "idle" | "starting" | "running" | "stopping";

export type WorkerHealthSnapshot = {
  health: AgentHealth;
  activeRun: RuntimeActiveRun | null;
  activeAgentCount: number;
  protocolVersion?: string;
  pid: number;
  deviceId: string | null;
  voiceBusy?: boolean;
  pendingVoiceRequestCount?: number;
  socialSessions?: SocialSessionServiceSnapshot;
};

type InFlightDrainWaiter = {
  resolve: () => void;
  promise: Promise<void>;
};

export const waitForWorkerProcessExit = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 1_500,
) => {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {}
      finish();
    }, timeoutMs);
    timeout.unref?.();
  });
};

/**
 * Close the IPC channel without killing the worker process. Used when
 * the worker self-supervises (UDS detached mode) so an Electron restart
 * leaves the worker running for the next host to attach.
 */
export const disconnectWorker = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 1_500,
) => {
  // Fast path: the process already exited (e.g. an explicit killWorker() just
  // confirmed it dead, so its socket is already closing). The shim's `exit`
  // event has likely fired before we could attach a listener, which would make
  // the loop below sit out the entire timeout fallback waiting for an event
  // that won't come again. Closing stdin is a no-op on a dead socket.
  if (child.exitCode != null || child.signalCode != null) {
    try {
      child.stdin?.end();
    } catch {
      // Best effort.
    }
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    // For UDS adapters, buildProcessShim intentionally maps stdin to the
    // underlying Socket; ending stdin is the IPC-disconnect operation. For
    // real ChildProcessWithoutNullStreams, ending stdin makes the child read
    // EOF and exit naturally — but we give it a timeout fallback so a
    // noncooperative worker doesn't hang the host.
    try {
      child.stdin?.end();
    } catch {
      // Best effort.
    }
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
};

export type RuntimeWorkerLifecycleControllerOptions = {
  workerEntryPath: string;
  isHostStarted: () => boolean;
  /**
   * Connection factory. Production path: spawns or attaches to the
   * detached worker via `runtime/host/lifecycle.ts`, then wraps the
   * resulting Unix-domain-socket in a JsonRpcPeer. Returns a
   * `WorkerConnection` whose `process.kill()` only kills the worker if
   * `killWorkerOnStop?.(reason)` is true (so an Electron restart leaves
   * the worker running for the next host). Tests inject a mock here.
   */
  createConnectionAsync: (
    workerEntryPath: string,
  ) => Promise<WorkerConnection>;
  initializeConnection: (connection: WorkerConnection) => Promise<void>;
  onConnectionStarted: (connection: WorkerConnection) => Promise<void>;
  onUnexpectedExit: () => Promise<void> | void;
  onAfterStop: (reason: "idle" | "restart" | "stopped") => Promise<void> | void;
  onStateChange?: (state: WorkerLifecycleState) => void;
  fetchHealth: (
    connection: WorkerConnection,
  ) => Promise<WorkerHealthSnapshot | null>;
  /**
   * Decide whether `stop(reason)` should also kill the underlying worker
   * process via SIGTERM/SIGKILL, or whether closing the IPC channel is
   * enough because the worker self-supervises (UDS-detached path).
   * Defaults to "always kill" (legacy stdio-child semantics).
   *
   * Production passes `(reason) => reason === "restart"` so:
   *   - "stopped" / "idle" close the socket; worker stays alive ~10s
   *     so the next Electron host can reattach without loss.
   *   - "restart" actually kills the worker pid (e.g. runtime code
   *     reload that needs a fresh process).
   */
  killWorkerOnStop?: (reason: "idle" | "restart" | "stopped") => boolean;
  /**
   * Optional explicit worker kill — used by the UDS path when
   * `killWorkerOnStop` returns true. Falls back to
   * `connection.process.kill("SIGTERM")` when omitted.
   */
  killWorker?: () => Promise<void>;
};

export class RuntimeWorkerLifecycleController {
  private connection: WorkerConnection | null = null;
  private startupPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stoppingPid: number | null = null;
  private state: WorkerLifecycleState = "idle";
  private inFlightWorkerRequests = 0;
  private inFlightDrainWaiter: InFlightDrainWaiter | null = null;

  constructor(
    private readonly options: RuntimeWorkerLifecycleControllerOptions,
  ) {}

  getState() {
    return this.state;
  }

  getConnection() {
    return this.connection;
  }

  private getLivePeer() {
    const peer = this.connection?.peer;
    return peer && !peer.isClosed() ? peer : null;
  }

  private setState(nextState: WorkerLifecycleState) {
    this.state = nextState;
    this.options.onStateChange?.(nextState);
  }

  private getOrCreateInFlightDrainWaiter() {
    if (this.inFlightDrainWaiter) {
      return this.inFlightDrainWaiter;
    }
    let resolve = () => {};
    const promise = new Promise<void>((innerResolve) => {
      resolve = innerResolve;
    });
    this.inFlightDrainWaiter = { resolve, promise };
    return this.inFlightDrainWaiter;
  }

  private incrementInFlightWorkerRequests() {
    this.inFlightWorkerRequests += 1;
  }

  private decrementInFlightWorkerRequests() {
    this.inFlightWorkerRequests = Math.max(0, this.inFlightWorkerRequests - 1);
    if (this.inFlightWorkerRequests === 0 && this.inFlightDrainWaiter) {
      const waiter = this.inFlightDrainWaiter;
      this.inFlightDrainWaiter = null;
      waiter.resolve();
    }
  }

  private async waitForInFlightWorkerRequestsToDrain(timeoutMs = 1_500) {
    if (this.inFlightWorkerRequests === 0) {
      return;
    }
    const waiter = this.getOrCreateInFlightDrainWaiter();
    await Promise.race([waiter.promise, delay(timeoutMs)]);
  }

  async ensureStarted() {
    if (!this.options.isHostStarted()) {
      throw createRuntimeUnavailableError(
        "Stella runtime host is not started.",
      );
    }
    if (this.state === "running" && this.getLivePeer()) return;
    if (this.state === "stopping" && this.stopPromise) {
      await this.stopPromise;
    }
    if (this.startupPromise) {
      await this.startupPromise;
      return;
    }

    this.setState("starting");
    this.startupPromise = (async () => {
      // The detached-UDS factory manages its own lifecycle (single-instance
      // via flock, idempotent attach), so there is no stale-child sweep here.
      const connection = await this.options.createConnectionAsync(
        this.options.workerEntryPath,
      );
      this.connection = connection;
      this.stoppingPid = null;

      connection.peer.on("closed", () => {
        if (this.connection?.peer !== connection.peer) {
          return;
        }
        this.connection = null;
        if (this.state === "running") {
          this.setState("idle");
        }
      });

      connection.process.once("exit", () => {
        const wasIntentional = this.stoppingPid === connection.pid;
        if (this.connection?.process === connection.process) {
          this.connection = null;
        }
        if (!wasIntentional) {
          this.setState("idle");
        }
        if (this.stopPromise && wasIntentional) return;
        if (this.options.isHostStarted()) {
          void this.options.onUnexpectedExit();
        }
      });

      try {
        await this.options.initializeConnection(connection);
        await this.options.onConnectionStarted(connection);
        this.setState("running");
      } catch (error) {
        if (this.connection?.pid === connection.pid) {
          this.connection = null;
        }
        this.setState("idle");
        try {
          await waitForWorkerProcessExit(connection.process);
        } catch {}
        throw error;
      }
    })();

    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
      if (!this.connection?.peer && this.state === "starting") {
        this.setState("idle");
      }
    }
  }

  async stop(reason: "idle" | "restart" | "stopped") {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    const connection = this.connection;
    if (!connection) return;
    if (reason !== "idle") {
      await this.waitForInFlightWorkerRequestsToDrain();
    }
    this.setState("stopping");
    this.stoppingPid = connection.pid;
    const shouldKill =
      this.options.killWorkerOnStop?.(reason) ?? true;
    this.stopPromise = (shouldKill
      ? this.options.killWorker
        ? this.options
            .killWorker()
            .then(() => disconnectWorker(connection.process, 100))
        : waitForWorkerProcessExit(connection.process)
      : disconnectWorker(connection.process)
    ).finally(() => {
      if (this.connection?.pid === connection.pid) {
        this.connection = null;
      }
      this.stoppingPid = null;
      this.stopPromise = null;
      this.setState("idle");
    });
    await this.stopPromise;
    if (this.options.isHostStarted()) {
      await this.options.onAfterStop(reason);
    }
  }

  async request<TResult>(
    execute: (peer: JsonRpcPeer) => Promise<TResult>,
    options: {
      ensureWorker: boolean;
      recordActivity: boolean;
      retryOnceOnDisconnect?: boolean;
    },
  ): Promise<TResult> {
    if (options.ensureWorker) {
      await this.ensureStarted();
    }
    const peer = this.getLivePeer();
    if (!peer) {
      throw createRuntimeUnavailableError("Runtime worker is not running.");
    }
    this.incrementInFlightWorkerRequests();
    try {
      return await execute(peer);
    } catch (error) {
      if (
        options.retryOnceOnDisconnect &&
        this.options.isHostStarted() &&
        !this.getLivePeer()
      ) {
        await this.ensureStarted();
        return await this.request(execute, {
          ...options,
          retryOnceOnDisconnect: false,
        });
      }
      throw error;
    } finally {
      this.decrementInFlightWorkerRequests();
    }
  }

  async getHealth(args: { ensureWorker: boolean }) {
    if (args.ensureWorker) {
      await this.ensureStarted();
    }
    const connection = this.connection;
    if (!connection || connection.peer.isClosed()) return null;
    return await this.options.fetchHealth(connection);
  }

}
