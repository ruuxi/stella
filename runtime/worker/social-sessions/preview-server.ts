/**
 * Per-session Vite dev server manager.
 *
 * Owns one child Vite process per active social session workspace.
 * Discovers the bound URL by parsing Vite's stdout (looking for the
 * "Local: http://..." line). Re-uses an already-running server for the
 * same session, restarts crashed servers, and tears everything down on
 * service stop.
 *
 * Dependencies are installed with `bun install`, then Vite is started via
 * `bun x vite` inside the per-session folder. The caller must have `bun` on
 * PATH. Each child runs as the leader of its own process group on Unix so the
 * whole tree can be killed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

type PreviewState = "starting" | "running" | "stopping" | "stopped" | "error";

type PreviewEntry = {
  sessionId: string;
  workspacePath: string;
  child: ChildProcess | null;
  state: PreviewState;
  url: string | null;
  port: number | null;
  startedAt: number;
  lastError: string | null;
  startPromise: Promise<string | null> | null;
  stopPromise: Promise<void> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
};

export type PreviewSnapshot = {
  sessionId: string;
  workspacePath: string;
  state: PreviewState;
  url: string | null;
  port: number | null;
  startedAt: number;
  lastError: string | null;
};

export type PreviewServerManagerEvents = {
  onUrlAvailable?: (snapshot: PreviewSnapshot) => void;
  onStopped?: (snapshot: PreviewSnapshot) => void;
};

const VITE_LOG_PREFIX = "[social-preview]";
const URL_DISCOVERY_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 120_000;
const RESTART_BACKOFF_MS = 5_000;
const STOP_GRACE_MS = 1_500;

const URL_LINE_REGEX =
  /Local:\s+(https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?\/[^\s]*)/i;

const log = (message: string, extra?: Record<string, unknown>) => {
  if (extra) {
    // eslint-disable-next-line no-console
    console.log(`${VITE_LOG_PREFIX} ${message}`, extra);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${VITE_LOG_PREFIX} ${message}`);
  }
};

const logWarn = (message: string, extra?: Record<string, unknown>) => {
  if (extra) {
    // eslint-disable-next-line no-console
    console.warn(`${VITE_LOG_PREFIX} ${message}`, extra);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`${VITE_LOG_PREFIX} ${message}`);
  }
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Parse Vite's "  Local:   http://127.0.0.1:5173/" line out of a chunk
 * of stdout. Returns null when no URL is present in this chunk.
 */
const findUrlInChunk = (
  chunk: string,
): { url: string; port: number | null } | null => {
  const match = chunk.match(URL_LINE_REGEX);
  if (!match) return null;
  const url = match[1]!.replace(/\/+$/, "");
  const port = match[2] ? Number(match[2]) : null;
  return { url, port: Number.isFinite(port) ? port : null };
};

const killChildProcessTree = async (child: ChildProcess) => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    try {
      const taskkill = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      await new Promise<void>((resolve) => {
        taskkill.once("exit", () => resolve());
        taskkill.once("error", () => resolve());
      });
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort fallback.
      }
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort fallback.
      }
    }
  }

  await Promise.race([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    }),
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (process.platform === "win32") {
            child.kill();
          } else if (child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          // Already exited.
        }
        resolve();
      }, STOP_GRACE_MS);
      timer.unref?.();
    }),
  ]);
};

export class SocialPreviewServerManager {
  private entries = new Map<string, PreviewEntry>();
  private stoppingAll = false;

  constructor(private readonly events: PreviewServerManagerEvents = {}) {}

  /**
   * Ensure a Vite dev server is running for the given session workspace.
   * Re-uses an existing running entry if present. Returns the resolved
   * URL once Vite has reported its listening address. Resolves to `null`
   * if startup fails or times out.
   */
  async ensureStarted(
    sessionId: string,
    workspacePath: string,
  ): Promise<string | null> {
    if (this.stoppingAll) {
      return null;
    }

    const existing = this.entries.get(sessionId);
    if (existing) {
      if (existing.workspacePath !== workspacePath) {
        await this.stopSession(sessionId);
      } else if (existing.state === "running" && existing.url) {
        return existing.url;
      } else if (existing.startPromise) {
        return existing.startPromise;
      } else if (existing.state === "starting") {
        return existing.startPromise ?? null;
      }
    }

    return this.startSession(sessionId, workspacePath);
  }

  /**
   * Stop the dev server for a session, if any. Idempotent.
   */
  async stopSession(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }
    if (entry.stopPromise) {
      await entry.stopPromise;
      return;
    }
    entry.state = "stopping";
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
    const stopPromise = (async () => {
      if (entry.child) {
        await killChildProcessTree(entry.child).catch(() => undefined);
      }
      entry.state = "stopped";
      entry.child = null;
      entry.url = null;
      entry.port = null;
      this.events.onStopped?.(this.toSnapshot(entry));
    })();
    entry.stopPromise = stopPromise;
    await stopPromise;
    this.entries.delete(sessionId);
  }

  /**
   * Stop every running dev server. Used at worker shutdown.
   */
  async shutdown(): Promise<void> {
    this.stoppingAll = true;
    try {
      const sessionIds = [...this.entries.keys()];
      await Promise.all(sessionIds.map((id) => this.stopSession(id)));
    } finally {
      this.stoppingAll = false;
    }
  }

  /**
   * Snapshot of all currently tracked dev servers.
   */
  list(): PreviewSnapshot[] {
    return [...this.entries.values()].map((entry) => this.toSnapshot(entry));
  }

  /**
   * Snapshot for a single session, or null when none is tracked.
   */
  get(sessionId: string): PreviewSnapshot | null {
    const entry = this.entries.get(sessionId);
    return entry ? this.toSnapshot(entry) : null;
  }

  private toSnapshot(entry: PreviewEntry): PreviewSnapshot {
    return {
      sessionId: entry.sessionId,
      workspacePath: entry.workspacePath,
      state: entry.state,
      url: entry.url,
      port: entry.port,
      startedAt: entry.startedAt,
      lastError: entry.lastError,
    };
  }

  private startSession(
    sessionId: string,
    workspacePath: string,
  ): Promise<string | null> {
    const entry: PreviewEntry = {
      sessionId,
      workspacePath,
      child: null,
      state: "starting",
      url: null,
      port: null,
      startedAt: Date.now(),
      lastError: null,
      startPromise: null,
      stopPromise: null,
      restartTimer: null,
    };
    this.entries.set(sessionId, entry);

    const startPromise = this.spawnVite(entry);
    entry.startPromise = startPromise;
    return startPromise.finally(() => {
      if (entry.startPromise === startPromise) {
        entry.startPromise = null;
      }
    });
  }

  private async spawnVite(entry: PreviewEntry): Promise<string | null> {
    if (this.stoppingAll) {
      entry.state = "stopped";
      return null;
    }

    if (!(await fileExists(path.join(entry.workspacePath, "package.json")))) {
      entry.state = "error";
      entry.lastError = "Workspace package.json missing.";
      logWarn("workspace missing package.json; not starting Vite", {
        sessionId: entry.sessionId,
        workspacePath: entry.workspacePath,
      });
      return null;
    }

    const installed = await this.ensureDependenciesInstalled(entry);
    if (
      !installed ||
      this.stoppingAll ||
      this.entries.get(entry.sessionId) !== entry ||
      entry.state === "stopping"
    ) {
      return null;
    }

    const env = {
      ...process.env,
      // Tell Vite to bind to an OS-chosen ephemeral port if `vite.config.ts`
      // does not pin one. Listening on 127.0.0.1 keeps the dev server off
      // the LAN by default.
      VITE_DEV_HOST: "127.0.0.1",
      // Suppress browser auto-open; Stella opens the preview in its own
      // display tab.
      BROWSER: "none",
      FORCE_COLOR: "0",
    } as NodeJS.ProcessEnv;

    let child: ChildProcess;
    try {
      child = spawn("bun", ["x", "vite", "--host", "127.0.0.1"], {
        cwd: entry.workspacePath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      entry.state = "error";
      entry.lastError =
        error instanceof Error ? error.message : "Failed to spawn Vite";
      logWarn("failed to spawn Vite", {
        sessionId: entry.sessionId,
        error: entry.lastError,
      });
      return null;
    }

    entry.child = child;
    log("vite started", {
      sessionId: entry.sessionId,
      pid: child.pid,
      workspacePath: entry.workspacePath,
    });

    let urlResolved = false;
    const urlPromise = new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        if (!urlResolved) {
          urlResolved = true;
          resolve(null);
        }
      }, URL_DISCOVERY_TIMEOUT_MS);
      timeout.unref?.();

      const handleChunk = (data: Buffer | string) => {
        const chunk = typeof data === "string" ? data : data.toString("utf8");
        const found = findUrlInChunk(chunk);
        if (!found || urlResolved) {
          return;
        }
        urlResolved = true;
        clearTimeout(timeout);
        entry.url = found.url;
        entry.port = found.port;
        entry.state = "running";
        entry.lastError = null;
        log("vite ready", {
          sessionId: entry.sessionId,
          url: entry.url,
          port: entry.port,
        });
        this.events.onUrlAvailable?.(this.toSnapshot(entry));
        resolve(found.url);
      };

      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", (data) => {
        // Vite occasionally prints the URL on stderr; also surface errors.
        handleChunk(data);
      });
    });

    child.once("exit", (code, signal) => {
      const wasRunning = entry.state === "running";
      const wasStopping = entry.state === "stopping";
      log("vite exited", {
        sessionId: entry.sessionId,
        code,
        signal,
        priorState: entry.state,
      });
      entry.child = null;
      if (wasStopping) {
        entry.state = "stopped";
        return;
      }
      entry.state = wasRunning ? "stopped" : "error";
      entry.url = null;
      entry.port = null;
      if (!entry.lastError && code != null && code !== 0) {
        entry.lastError = `Vite exited with code ${code}`;
      }
      this.events.onStopped?.(this.toSnapshot(entry));
      if (!this.stoppingAll && wasRunning) {
        this.scheduleRestart(entry);
      }
    });

    child.once("error", (error) => {
      entry.lastError = error.message;
      logWarn("vite child error", {
        sessionId: entry.sessionId,
        error: error.message,
      });
    });

    return urlPromise;
  }

  private scheduleRestart(entry: PreviewEntry) {
    if (this.stoppingAll) return;
    if (entry.restartTimer) return;
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      const stillTracked = this.entries.get(entry.sessionId);
      if (!stillTracked || this.stoppingAll) {
        return;
      }
      log("restarting vite after exit", { sessionId: entry.sessionId });
      void this.spawnVite(entry);
    }, RESTART_BACKOFF_MS);
    entry.restartTimer.unref?.();
  }

  private async ensureDependenciesInstalled(
    entry: PreviewEntry,
  ): Promise<boolean> {
    const reactDir = path.join(entry.workspacePath, "node_modules", "react");
    const viteDir = path.join(entry.workspacePath, "node_modules", "vite");
    if ((await fileExists(reactDir)) && (await fileExists(viteDir))) {
      return true;
    }

    log("installing workspace dependencies", {
      sessionId: entry.sessionId,
      workspacePath: entry.workspacePath,
    });

    const child = spawn("bun", ["install", "--silent"], {
      cwd: entry.workspacePath,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    entry.child = child;

    let output = "";
    const appendOutput = (data: Buffer | string) => {
      output += typeof data === "string" ? data : data.toString("utf8");
      if (output.length > 4_000) {
        output = output.slice(-4_000);
      }
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    const exitCode = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => {
        void killChildProcessTree(child).finally(() => resolve(null));
      }, INSTALL_TIMEOUT_MS);
      timeout.unref?.();
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
      child.once("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });
    });
    if (entry.child === child) {
      entry.child = null;
    }

    if (
      this.stoppingAll ||
      this.entries.get(entry.sessionId) !== entry ||
      entry.state === "stopping"
    ) {
      return false;
    }

    if (exitCode === 0) {
      return true;
    }

    entry.state = "error";
    entry.lastError =
      exitCode === null
        ? "Dependency install timed out or failed to start."
        : `Dependency install failed with code ${exitCode}.`;
    logWarn("workspace dependency install failed", {
      sessionId: entry.sessionId,
      error: entry.lastError,
      output,
    });
    return false;
  }
}
