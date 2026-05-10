import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import {
  existsSync,
  openSync,
  closeSync,
  writeFileSync,
  promises as fsPromises,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  resolveRuntimePaths,
  type RuntimePaths,
} from "../worker/runtime-paths.js";
import {
  STELLA_RUNTIME_READY_METHOD,
  type RuntimeInitializeResult,
} from "../protocol/index.js";
import {
  probeRunningWorker,
  removeStaleRuntimeArtifacts,
} from "../worker/lifecycle-server.js";

/**
 * Host-side lifecycle: discover or launch the detached worker and
 * return a connected UDS Socket the caller can wrap with a JSON-RPC
 * peer.
 *
 * Discovery flow:
 *   1. Resolve ~/.stella/runtime/<rootHash>/runtime.{pid,sock}.
 *   2. If pidfile points to a live process AND we can connect to the
 *      socket, reuse it. This is the "Electron just restarted, reattach"
 *      path. Protocol or host-executable mismatch is a hard worker restart;
 *      in-flight work is not preserved across that compatibility boundary.
 *   3. Otherwise (no pidfile, dead pid, or socket refusing connections),
 *      spawn a fresh detached worker pointed at the same paths and poll
 *      until it answers a lightweight RPC readiness probe.
 *
 * Lifecycle ops are serialized per-stellaRoot via a flock-style file
 * (`runtime.host.lock`) so concurrent host starts don't race the spawn.
 */

const START_POLL_INTERVAL_MS = 50;
const START_TIMEOUT_MS = 10_000;
const SOCKET_CONNECT_TIMEOUT_MS = 1_000;
const HOST_LOCK_TIMEOUT_MS = 75_000;
const WORKER_READY_PROBE_ID = "__stella_runtime_ready_probe__";

type ReadyProbeResult = "ready" | "version-mismatch" | "unavailable";

export type LifecycleConnection = {
  socket: Socket;
  pid: number;
  paths: RuntimePaths;
  /** True if we spawned the worker; false if we attached to an existing one. */
  spawned: boolean;
};

export type LifecycleStartOptions = {
  stellaRoot: string;
  workerEntryPath: string;
  bunBinaryPath?: string;
  idleShutdownMs?: number;
  /**
   * Extra env merged onto the child process. The host adapter passes
   * NODE_ENV, custom debug flags, etc.
   */
  env?: NodeJS.ProcessEnv;
  expectedProtocolVersion?: string;
  hostExecutablePath?: string;
};

const tryConnectSocket = async (
  socketPath: string,
  timeoutMs: number,
): Promise<Socket | null> => {
  if (!existsSync(socketPath)) return null;
  return await new Promise<Socket | null>((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (result: Socket | null) => {
      if (settled) return;
      settled = true;
      if (result == null) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      finish(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
};

const probeWorkerRpcReadiness = async (
  socket: Socket,
  timeoutMs: number,
  expectedProtocolVersion?: string,
): Promise<ReadyProbeResult> => {
  return await new Promise<ReadyProbeResult>((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (result: ReadyProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as {
              id?: unknown;
              result?: unknown;
              error?: unknown;
            };
            if (message.id === WORKER_READY_PROBE_ID) {
              if (message.error) {
                finish("unavailable");
                return;
              }
              const result = message.result as
                | Partial<RuntimeInitializeResult>
                | undefined;
              if (
                expectedProtocolVersion &&
                result?.protocolVersion !== expectedProtocolVersion
              ) {
                finish("version-mismatch");
                return;
              }
              finish("ready");
              return;
            }
          } catch {
            // Ignore unrelated malformed probe data and keep waiting.
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    };
    const onError = () => finish("unavailable");
    const timer = setTimeout(() => finish("unavailable"), timeoutMs);
    timer.unref?.();
    socket.on("data", onData);
    socket.once("error", onError);
    socket.write(
      `${JSON.stringify({
        id: WORKER_READY_PROBE_ID,
        method: STELLA_RUNTIME_READY_METHOD,
      })}\n`,
    );
  });
};

const tryConnectReadySocket = async (
  socketPath: string,
  timeoutMs: number,
  expectedProtocolVersion?: string,
): Promise<
  | { status: "ready"; socket: Socket }
  | { status: "version-mismatch" | "unavailable" }
> => {
  const probeSocket = await tryConnectSocket(socketPath, timeoutMs);
  if (!probeSocket) return { status: "unavailable" };
  const ready = await probeWorkerRpcReadiness(
    probeSocket,
    timeoutMs,
    expectedProtocolVersion,
  );
  probeSocket.destroy();
  if (ready !== "ready") return { status: ready };
  // Return a clean socket with no probe listeners or consumed data so the
  // normal JSON-RPC peer owns the stream from byte zero.
  const socket = await tryConnectSocket(socketPath, timeoutMs);
  return socket ? { status: "ready", socket } : { status: "unavailable" };
};

const hostExecutableMatches = async (
  paths: RuntimePaths,
  expectedHostExecutablePath?: string,
): Promise<boolean> => {
  if (!expectedHostExecutablePath) return true;
  try {
    const raw = await fsPromises.readFile(paths.hostExecutableFile, "utf-8");
    return raw.trim() === expectedHostExecutablePath;
  } catch {
    return false;
  }
};

const acquireHostLock = async (lockFile: string): Promise<number> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HOST_LOCK_TIMEOUT_MS) {
    try {
      const fd = openSync(lockFile, "wx");
      try {
        writeFileSync(fd, String(process.pid), "utf-8");
      } catch (error) {
        closeSync(fd);
        await fsPromises.unlink(lockFile).catch(() => undefined);
        throw error;
      }
      return fd;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      await delay(50);
      // If the holder died, sweep the lock and try again.
      try {
        const raw = await fsPromises.readFile(lockFile, "utf-8");
        const pid = Number.parseInt(raw.trim(), 10);
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            // Holder is alive, keep waiting.
            continue;
          } catch {
            // Holder is dead — clear the lock and retry.
            await fsPromises.unlink(lockFile).catch(() => undefined);
          }
        } else {
          await fsPromises.unlink(lockFile).catch(() => undefined);
        }
      } catch {
        // Lock removed by another process; try again.
      }
    }
  }
  throw new Error(
    `Timed out acquiring runtime host lock at ${lockFile} after ${HOST_LOCK_TIMEOUT_MS}ms.`,
  );
};

const releaseHostLock = async (
  lockFile: string,
  fd: number,
): Promise<void> => {
  try {
    closeSync(fd);
  } catch {
    // Ignore close errors during release.
  }
  await fsPromises.unlink(lockFile).catch(() => undefined);
};

const spawnDetachedWorker = (
  options: LifecycleStartOptions,
  paths: RuntimePaths,
): ChildProcess => {
  const args = [
    "run",
    options.workerEntryPath,
    "--listen",
    `unix://${paths.socketPath}`,
    "--stella-root",
    options.stellaRoot,
  ];
  if (options.idleShutdownMs && options.idleShutdownMs > 0) {
    args.push("--idle-shutdown-ms", String(options.idleShutdownMs));
  }
  const logFd = openSync(paths.logFile, "a");
  let child: ChildProcess;
  try {
    if (options.env?.NODE_ENV === "development") {
      console.warn(`[runtime-host] Detached worker logs: ${paths.logFile}`);
    }
    child = spawn(options.bunBinaryPath ?? "bun", args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        ...(options.env ?? {}),
        ...(options.hostExecutablePath
          ? { STELLA_HOST_EXECUTABLE_PATH: options.hostExecutablePath }
          : {}),
      },
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  return child;
};

const pollForWorkerReady = async (
  paths: RuntimePaths,
  timeoutMs: number,
  expectedProtocolVersion?: string,
): Promise<Socket> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = await tryConnectReadySocket(
      paths.socketPath,
      SOCKET_CONNECT_TIMEOUT_MS,
      expectedProtocolVersion,
    );
    if (socket.status === "ready") return socket.socket;
    if (socket.status === "version-mismatch") {
      throw new Error(
        `Runtime worker protocol mismatch while waiting for socket=${paths.socketPath}.`,
      );
    }
    await delay(START_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for runtime worker to become ready (socket=${paths.socketPath}).`,
  );
};

/**
 * Resolve a connected socket to the runtime worker, spawning a new
 * worker if one is not already running for `stellaRoot`. Idempotent
 * across hosts thanks to the host-side lock.
 */
export const startOrAttachWorker = async (
  options: LifecycleStartOptions,
): Promise<LifecycleConnection> => {
  const paths = resolveRuntimePaths(options.stellaRoot);
  await fsPromises.mkdir(paths.rootDir, { recursive: true });
  const hostLockFile = `${paths.lockFile}.host`;
  const fd = await acquireHostLock(hostLockFile);
  try {
    const existingPid = await probeRunningWorker(options.stellaRoot);
    if (existingPid != null) {
      const executableMatches = await hostExecutableMatches(
        paths,
        options.hostExecutablePath,
      );
      if (!executableMatches) {
        console.warn(
          `[runtime-host] Existing worker executable mismatch; restarting detached worker (pid=${existingPid}). In-flight work cannot be preserved across host bundle changes.`,
        );
        await stopRunningWorker(options.stellaRoot);
        await removeStaleRuntimeArtifacts(options.stellaRoot);
      } else {
        const ready = await tryConnectReadySocket(
          paths.socketPath,
          SOCKET_CONNECT_TIMEOUT_MS,
          options.expectedProtocolVersion,
        );
        if (ready.status === "ready") {
          return { socket: ready.socket, pid: existingPid, paths, spawned: false };
        }
        if (ready.status === "version-mismatch") {
          console.warn(
            `[runtime-host] Existing worker protocol mismatch; restarting detached worker (pid=${existingPid}). In-flight work cannot be preserved across protocol changes.`,
          );
          await stopRunningWorker(options.stellaRoot);
          await removeStaleRuntimeArtifacts(options.stellaRoot);
        } else {
          // Pid is alive but socket isn't reachable — likely a worker that's
          // still binding the socket. Wait briefly before declaring it stale.
          const retry = await pollForWorkerReady(
            paths,
            2_000,
            options.expectedProtocolVersion,
          ).catch(() => null);
          if (retry) {
            return { socket: retry, pid: existingPid, paths, spawned: false };
          }
          // Truly stale; sweep the artifacts and continue to spawn.
          await removeStaleRuntimeArtifacts(options.stellaRoot);
        }
      }
    } else {
      await removeStaleRuntimeArtifacts(options.stellaRoot);
    }

    spawnDetachedWorker(options, paths);
    const socket = await pollForWorkerReady(
      paths,
      START_TIMEOUT_MS,
      options.expectedProtocolVersion,
    );
    const newPid = (await probeRunningWorker(options.stellaRoot)) ?? 0;
    return { socket, pid: newPid, paths, spawned: true };
  } finally {
    await releaseHostLock(hostLockFile, fd);
  }
};

/**
 * Stop a running worker by SIGTERM-then-SIGKILL. The worker also has its
 * own self-shutdown-on-idle timer, so this is mostly used by tests and
 * by `runtime restart` flows that want a synchronous tear-down.
 */
export const stopRunningWorker = async (
  stellaRoot: string,
  options?: { graceMs?: number },
): Promise<{ stopped: boolean; pid: number | null }> => {
  const pid = await probeRunningWorker(stellaRoot);
  if (pid == null) return { stopped: false, pid: null };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { stopped: false, pid };
  }
  const graceMs = options?.graceMs ?? 1_500;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await delay(50);
    } catch {
      return { stopped: true, pid };
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline) {
    try {
      process.kill(pid, 0);
      await delay(50);
    } catch {
      return { stopped: true, pid };
    }
  }
  return { stopped: true, pid };
};
