import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
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
  activeTaskCount: number;
  pid: number;
  deviceId: string | null;
  voiceBusy?: boolean;
  pendingVoiceRequestCount?: number;
  remoteBridgeActive?: boolean;
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
      console.error("[runtime-client] worker RPC error:", error);
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
  createConnection?: (workerEntryPath: string) => WorkerConnection;
  initializeConnection: (connection: WorkerConnection) => Promise<void>;
  onConnectionStarted: (connection: WorkerConnection) => Promise<void>;
  onUnexpectedExit: () => Promise<void> | void;
  onAfterStop: (reason: "idle" | "restart" | "stopped") => Promise<void> | void;
  onStateChange?: (state: WorkerLifecycleState) => void;
  fetchHealth: (connection: WorkerConnection) => Promise<WorkerHealthSnapshot | null>;
  idleTimeoutMs?: number;
  idleRecheckMs?: number;
};

const shouldKeepWorkerAlive = (health: WorkerHealthSnapshot) => {
  const social = health.socialSessions ?? createEmptySocialSessionServiceSnapshot();
  const socialPinned = social.sessionCount > 0 || Boolean(social.processingTurnId);
  const voicePinned =
    Boolean(health.voiceBusy) || (health.pendingVoiceRequestCount ?? 0) > 0;

  return Boolean(
    health.activeRun ||
    health.activeTaskCount > 0 ||
    socialPinned ||
    voicePinned ||
    health.remoteBridgeActive,
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
    await Promise.race([
      waiter.promise,
      delay(timeoutMs),
    ]);
  }

  private noteExecutionActivity() {
    this.lastExecutionActivityAt = Date.now();
  }

  async ensureStarted() {
    if (!this.options.isHostStarted()) {
      throw createRuntimeUnavailableError("Stella runtime host is not started.");
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
      const connection = (this.options.createConnection ?? createWorkerConnection)(
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
    this.stopPromise = waitForWorkerProcessExit(connection.process).finally(() => {
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
        this.activeExecutionRequests = Math.max(0, this.activeExecutionRequests - 1);
        this.noteExecutionActivity();
      }
      this.scheduleIdleEvaluation();
    }
  }

  async getHealth(args: { ensureWorker: boolean }) {
    if (args.ensureWorker) {
      await this.ensureStarted();
    }
    if (!this.connection?.peer) return null;
    return await this.options.fetchHealth(this.connection);
  }

  private scheduleIdleEvaluation(
    delayMs = this.options.idleTimeoutMs ?? 5 * 60 * 1_000,
  ) {
    if (!this.connection?.peer || !this.options.isHostStarted() || this.state !== "running") {
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
    if (!this.connection?.peer || !this.options.isHostStarted() || this.state !== "running") {
      return;
    }
    if (this.inFlightWorkerRequests > 0 || this.activeExecutionRequests > 0) {
      this.scheduleIdleEvaluation(this.options.idleRecheckMs ?? 30_000);
      return;
    }
    const idleTimeoutMs = this.options.idleTimeoutMs ?? 5 * 60 * 1_000;
    const idleForMs = Date.now() - this.lastExecutionActivityAt;
    if (idleForMs < idleTimeoutMs) {
      this.scheduleIdleEvaluation(idleTimeoutMs - idleForMs);
      return;
    }
    const health = await this.getHealth({ ensureWorker: false }).catch(() => null);
    if (!health) return;
    if (shouldKeepWorkerAlive(health)) {
      this.scheduleIdleEvaluation(this.options.idleRecheckMs ?? 30_000);
      return;
    }
    await this.stop("idle");
  }
}
