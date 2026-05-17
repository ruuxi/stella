import {
  closeSync,
  createWriteStream,
  existsSync,
  openSync,
  promises as fsPromises,
  type WriteStream,
} from "node:fs";
import { resolveRuntimePaths, type RuntimePaths } from "./runtime-paths.js";

/**
 * Worker-side lifecycle helpers. The detached worker is responsible for:
 *
 *   1. Acquiring a per-stellaRoot lockfile so multiple workers can't
 *      overlap (one would lose the socket race anyway, but failing fast
 *      is friendlier than a half-broken second worker).
 *   2. Writing its pid to a discoverable file so the host can detect
 *      "is the worker still alive?" without an IPC roundtrip.
 *   3. Maintaining a self-shutdown timer that fires when no client has
 *      been connected for `idleShutdownMs`. This is what lets the
 *      worker outlive the host across restart but eventually die when
 *      nobody comes back (matching codex's 30-min thread-loaded model
 *      at a smaller granularity).
 *
 * The flock on `runtime.lock` is non-blocking and exclusive — we use
 * `O_EXCL` with `O_CREAT` to avoid a separate lock file race. On macOS
 * and Linux this is sufficient; Windows is out of scope (the worker is
 * Unix-only post-detach for now, matching codex daemon's posture).
 */

export type LifecycleServerOptions = {
  stellaRoot: string;
  idleShutdownMs?: number;
  /**
   * Called before self-shutdown when the last host client has been gone
   * for `idleShutdownMs`. Returning true pins the detached worker and
   * re-arms the idle timer instead of exiting. This is the critical
   * difference between "survives short Electron restarts" and "survives
   * Electron crashing mid-agent-run": active work owns the lifetime, not
   * merely client attachment.
   */
  shouldKeepAlive?: () => Promise<boolean> | boolean;
  onShutdown: (reason: "idle" | "signal") => Promise<void> | void;
};

const DEFAULT_IDLE_SHUTDOWN_MS = 10_000;

const pidIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readPidFile = async (pidFile: string): Promise<number | null> => {
  try {
    const raw = await fsPromises.readFile(pidFile, "utf-8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export class WorkerLifecycleServer {
  readonly paths: RuntimePaths;
  private lockFd: number | null = null;
  private logStream: WriteStream | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private clientCount = 0;
  private shuttingDown = false;
  private readonly idleShutdownMs: number;

  constructor(private readonly options: LifecycleServerOptions) {
    this.paths = resolveRuntimePaths(options.stellaRoot);
    this.idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  }

  /**
   * Acquire the lock, write pid + root marker, and route stdout/stderr
   * to the rotating log file. Throws if another worker already holds
   * the lock for the same stellaRoot.
   */
  async start(): Promise<void> {
    await fsPromises.mkdir(this.paths.rootDir, { recursive: true });

    // Stale lock cleanup: if the lock file exists but the recorded pid
    // is dead, take ownership. This avoids the "crashed worker leaves
    // a lock file behind, every subsequent start fails" problem.
    if (existsSync(this.paths.lockFile)) {
      const stalePid = await readPidFile(this.paths.lockFile);
      if (stalePid != null && !pidIsAlive(stalePid)) {
        await fsPromises.unlink(this.paths.lockFile).catch(() => undefined);
      }
    }

    try {
      this.lockFd = openSync(this.paths.lockFile, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new Error(
          `Another runtime worker is already running for ${this.options.stellaRoot} (lock at ${this.paths.lockFile}).`,
        );
      }
      throw error;
    }

    await fsPromises.writeFile(
      this.paths.lockFile,
      String(process.pid),
      "utf-8",
    );
    await fsPromises.writeFile(
      this.paths.pidFile,
      String(process.pid),
      "utf-8",
    );
    await fsPromises.writeFile(
      this.paths.rootMarkerFile,
      `${this.options.stellaRoot}\n`,
      "utf-8",
    );
    const hostExecutablePath = process.env.STELLA_HOST_EXECUTABLE_PATH;
    if (hostExecutablePath) {
      await fsPromises.writeFile(
        this.paths.hostExecutableFile,
        `${hostExecutablePath}\n`,
        "utf-8",
      );
    }

    // Open the log stream lazily; entry.ts decides whether to redirect
    // stdio to it. Background sweeps and explicit logs go through here.
    this.logStream = createWriteStream(this.paths.logFile, {
      flags: "a",
      encoding: "utf-8",
    });
    this.logStream.write(
      `\n[${new Date().toISOString()}] worker pid=${process.pid} listening (root=${this.options.stellaRoot})\n`,
    );
  }

  /**
   * Inform the lifecycle that a client connected. Cancels any pending
   * idle-shutdown timer.
   */
  noteClientConnected() {
    this.clientCount += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Inform the lifecycle that a client disconnected. If no clients are
   * left, schedule self-shutdown after `idleShutdownMs`.
   */
  noteClientDisconnected() {
    this.clientCount = Math.max(0, this.clientCount - 1);
    if (this.clientCount > 0) return;
    this.scheduleIdleShutdown();
  }

  private scheduleIdleShutdown() {
    if (this.shuttingDown) return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.evaluateIdleShutdown();
    }, this.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  private async evaluateIdleShutdown() {
    if (this.shuttingDown || this.clientCount > 0) return;
    const keepAlive = await Promise.resolve(
      this.options.shouldKeepAlive?.() ?? false,
    ).catch((error) => {
      this.logStream?.write(
        `[${new Date().toISOString()}] keep-alive check failed: ${(error as Error).message}\n`,
      );
      // If the check itself fails, prefer preserving in-flight work over
      // exiting unexpectedly. The next timer tick gets another chance.
      return true;
    });
    if (keepAlive) {
      this.logStream?.write(
        `[${new Date().toISOString()}] worker has active work; delaying idle shutdown\n`,
      );
      this.scheduleIdleShutdown();
      return;
    }
    this.logStream?.write(
      `[${new Date().toISOString()}] worker idle for ${this.idleShutdownMs}ms with no active work, shutting down\n`,
    );
    await this.shutdown("idle");
  }

  /**
   * Tear everything down: cancel timers, run the consumer-provided
   * shutdown hook, release the lock, and remove pid + socket files.
   */
  async shutdown(reason: "idle" | "signal"): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      await this.options.onShutdown(reason);
    } catch (error) {
      this.logStream?.write(
        `[${new Date().toISOString()}] shutdown handler error: ${(error as Error).message}\n`,
      );
    }
    await this.releaseFiles();
    this.logStream?.end();
    this.logStream = null;
  }

  private async releaseFiles() {
    if (this.lockFd != null) {
      try {
        closeSync(this.lockFd);
      } catch {
        // Ignore close errors during shutdown.
      }
      this.lockFd = null;
    }
    await fsPromises.unlink(this.paths.lockFile).catch(() => undefined);
    await fsPromises.unlink(this.paths.pidFile).catch(() => undefined);
  }
}

/**
 * Best-effort probe used by the host before spawning: returns the pid
 * of an already-running worker if the lockfile is alive, else null.
 */
export const probeRunningWorker = async (
  stellaRoot: string,
): Promise<number | null> => {
  const paths = resolveRuntimePaths(stellaRoot);
  if (!existsSync(paths.pidFile)) return null;
  const pid = await readPidFile(paths.pidFile);
  if (pid == null || !pidIsAlive(pid)) return null;
  return pid;
};

export const removeStaleRuntimeArtifacts = async (
  stellaRoot: string,
): Promise<void> => {
  const paths = resolveRuntimePaths(stellaRoot);
  for (const filePath of [
    paths.pidFile,
    paths.lockFile,
    paths.socketPath,
    paths.cliBridgeSocketPath,
    paths.hostExecutableFile,
  ]) {
    await fsPromises.unlink(filePath).catch(() => undefined);
  }
};

export const ensureRuntimeRootDir = async (
  stellaRoot: string,
): Promise<RuntimePaths> => {
  const paths = resolveRuntimePaths(stellaRoot);
  await fsPromises.mkdir(paths.rootDir, { recursive: true });
  return paths;
};
