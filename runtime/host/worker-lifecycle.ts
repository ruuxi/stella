import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { attachJsonRpcPeerToStreams } from "../protocol/jsonl.js";
import {
  createRuntimeUnavailableError,
  type JsonRpcPeer,
} from "../protocol/rpc-peer.js";
import { createEmptySocialSessionServiceSnapshot } from "../contracts/index.js";
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

const execFileAsync = promisify(execFile);

const findWorkerProcessIds = async (
  workerEntryPath: string,
): Promise<number[]> => {
  if (process.platform === "win32") {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", workerEntryPath], {
      windowsHide: true,
    });
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
};

const stopProcessId = async (pid: number) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_500) {
    try {
      process.kill(pid, 0);
      await delay(100);
    } catch {
      return;
    }
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort stale worker cleanup.
  }
};

const stopStaleWorkerProcesses = async (workerEntryPath: string) => {
  const pids = await findWorkerProcessIds(workerEntryPath);
  await Promise.allSettled(pids.map(stopProcessId));
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
 * Wait for the connection's `exit` event without sending any signal.
 * Used by the UDS path's "soft restart" branch where the worker pid was
 * already SIGTERM'd by an external `killWorker()` callback.
 */
export const waitForWorkerExitEvent = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5_000,
) => {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
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

const createWorkerConnection = (workerEntryPath: string) => {
  const child = spawn("bun", ["run", workerEntryPath], {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  const { peer } = attachJsonRpcPeerToStreams({
    input: child.stdout,
    output: child.stdin,
    onError: (error) => {
      console.error("[runtime-host] worker RPC error:", error);
    },
  });

  return {
    process: child,
    peer,
    pid: child.pid ?? 0,
  } satisfies WorkerConnection;
};

export type RuntimeWorkerLifecycleControllerOptions = {
  workerEntryPath: string;
  isHostStarted: () => boolean;
  /**
   * Sync connection factory. Used by tests that mock the connection
   * directly. Production uses `createConnectionAsync` (the detached-UDS
   * spawn path).
   */
  createConnection?: (workerEntryPath: string) => WorkerConnection;
  /**
   * Async connection factory. Production path: spawns or attaches to the
   * detached worker via `runtime/host/lifecycle.ts`, then wraps the
   * resulting Unix-domain-socket in a JsonRpcPeer. Returns a
   * `WorkerConnection` whose `process.kill()` only kills the worker if
   * `killWorkerOnStop?.(reason)` is true (so an Electron restart leaves
   * the worker running for the next host).
   */
  createConnectionAsync?: (
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
  idleTimeoutMs?: number;
  idleRecheckMs?: number;
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

const shouldKeepWorkerAlive = (health: WorkerHealthSnapshot) => {
  const social =
    health.socialSessions ?? createEmptySocialSessionServiceSnapshot();
  const socialPinned =
    social.sessionCount > 0 || Boolean(social.processingTurnId);
  const voicePinned =
    Boolean(health.voiceBusy) || (health.pendingVoiceRequestCount ?? 0) > 0;

  return Boolean(
    health.activeRun ||
      health.activeAgentCount > 0 ||
      socialPinned ||
      voicePinned,
  );
};

export class RuntimeWorkerLifecycleController {
  private connection: WorkerConnection | null = null;
  private startupPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stoppingPid: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private state: WorkerLifecycleState = "idle";
  private activeExecutionRequests = 0;
  private inFlightWorkerRequests = 0;
  private inFlightDrainWaiter: InFlightDrainWaiter | null = null;
  private lastExecutionActivityAt = 0;
  private hostFocused = true;

  constructor(
    private readonly options: RuntimeWorkerLifecycleControllerOptions,
  ) {}

  getState() {
    return this.state;
  }

  getConnection() {
    return this.connection;
  }

  private clearIdleTimer() {
    if (!this.idleTimer) {
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
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

  private noteExecutionActivity() {
    this.lastExecutionActivityAt = Date.now();
  }

  async ensureStarted() {
    if (!this.options.isHostStarted()) {
      throw createRuntimeUnavailableError(
        "Stella runtime host is not started.",
      );
    }
    if (this.state === "running" && this.connection?.peer) return;
    if (this.state === "stopping" && this.stopPromise) {
      await this.stopPromise;
    }
    if (this.startupPromise) {
      await this.startupPromise;
      return;
    }

    this.setState("starting");
    this.startupPromise = (async () => {
      // The detached-UDS path manages its own lifecycle (single-instance
      // via flock, idempotent attach), so we only sweep stale stdio
      // children when the host is still using the legacy spawn factory.
      if (!this.options.createConnectionAsync) {
        await stopStaleWorkerProcesses(this.options.workerEntryPath);
      }
      const connection = this.options.createConnectionAsync
        ? await this.options.createConnectionAsync(this.options.workerEntryPath)
        : (this.options.createConnection ?? createWorkerConnection)(
            this.options.workerEntryPath,
          );
      this.connection = connection;
      this.stoppingPid = null;

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
        this.noteExecutionActivity();
        this.scheduleIdleEvaluation();
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
    this.clearIdleTimer();
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
        ? this.options.killWorker().then(() =>
            waitForWorkerExitEvent(connection.process),
          )
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
    const peer = this.connection?.peer;
    if (!peer) {
      throw createRuntimeUnavailableError("Runtime worker is not running.");
    }
    this.incrementInFlightWorkerRequests();
    if (options.recordActivity) {
      this.activeExecutionRequests += 1;
      this.noteExecutionActivity();
    }
    try {
      return await execute(peer);
    } catch (error) {
      if (
        options.retryOnceOnDisconnect &&
        this.options.isHostStarted() &&
        !this.connection?.peer
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
      if (options.recordActivity) {
        this.activeExecutionRequests = Math.max(
          0,
          this.activeExecutionRequests - 1,
        );
        this.noteExecutionActivity();
      }
      this.scheduleIdleEvaluation();
    }
  }

  setHostFocused(focused: boolean) {
    if (this.hostFocused === focused) {
      return;
    }
    this.hostFocused = focused;
    if (focused) {
      this.clearIdleTimer();
      return;
    }
    this.scheduleIdleEvaluation(this.options.idleTimeoutMs ?? 0);
  }

  async getHealth(args: { ensureWorker: boolean }) {
    if (args.ensureWorker) {
      await this.ensureStarted();
    }
    if (!this.connection?.peer) return null;
    return await this.options.fetchHealth(this.connection);
  }

  private scheduleIdleEvaluation(
    delayMs = 0,
  ) {
    if (
      !this.connection?.peer ||
      !this.options.isHostStarted() ||
      this.state !== "running"
    ) {
      return;
    }
    if (this.hostFocused) {
      this.clearIdleTimer();
      return;
    }
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.evaluateIdle();
    }, delayMs);
    this.idleTimer.unref?.();
  }

  private async evaluateIdle() {
    if (
      !this.connection?.peer ||
      !this.options.isHostStarted() ||
      this.state !== "running"
    ) {
      return;
    }
    if (this.inFlightWorkerRequests > 0 || this.activeExecutionRequests > 0) {
      this.scheduleIdleEvaluation(this.options.idleRecheckMs ?? 30_000);
      return;
    }
    if (this.hostFocused) {
      this.clearIdleTimer();
      return;
    }
    const health = await this.getHealth({ ensureWorker: false }).catch(
      () => null,
    );
    if (!health) return;
    if (shouldKeepWorkerAlive(health)) {
      this.scheduleIdleEvaluation(this.options.idleRecheckMs ?? 30_000);
      return;
    }
    await this.stop("idle");
  }
}
