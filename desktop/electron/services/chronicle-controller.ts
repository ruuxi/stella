import { spawn, type ChildProcess, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveNativeHelperPath } from "../native-helper-path.js";
import { reapPidfileDaemon } from "./helper-pid-guard.js";
import { hasMacPermission, requestMacPermission } from "../utils/macos-permissions.js";
import {
  getChronicleEnabled,
  getChroniclePendingEnable,
  setChronicleMemoryPreference,
} from "../../../runtime/kernel/preferences/local-preferences.js";

/**
 * ChronicleController owns the lifecycle of the `chronicle` Swift sidecar.
 *
 * Responsibilities:
 *   - Resolve the binary location (dev + packaged)
 *   - Skip cleanly when disabled in `~/.stella/preferences.json` or when Screen
 *     Recording permission is not granted
 *   - Spawn the daemon as a detached process and remember the pid for
 *     status checks
 *   - Send `pause`/`resume`/`stop`/`status` commands over the AF_UNIX socket
 *   - Stop the daemon on app quit
 */

type ChronicleConfig = {
  intervalMs?: number;
  maxStrings?: number;
};

type StellaConfig = {
  chronicle?: ChronicleConfig;
};

const DEFAULT_CHRONICLE_INTERVAL_MS = 4_000;
const CHRONICLE_STARTUP_TIMEOUT_MS = 3_000;
const CHRONICLE_STARTUP_POLL_MS = 150;
const CHRONICLE_STARTUP_POLL_MAX_MS = 1_200;
const CHRONICLE_EXCLUDED_BUNDLE_IDS = ["com.stella.app", "com.github.Electron"];

const readConfig = async (stellaDataDir: string): Promise<ChronicleConfig> => {
  try {
    const raw = await fs.readFile(
      path.join(stellaDataDir, "config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as StellaConfig;
    return parsed.chronicle ?? {};
  } catch {
    return {};
  }
};

// The daemon is spawned detached + unref'd and the in-memory child handle is
// dropped on spawn error, so on quit we can't rely on `this.child` alone to
// reap it (orphan risk). Persist the pid to a file at spawn time and, if the
// socket `stop` didn't confirm exit, SIGTERM/SIGKILL the pidfile pid — the same
// belt-and-suspenders teardown as desktop-automation-cleanup.ts. The socket
// stop stays the primary path.
const chroniclePidFile = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "chronicle", "chronicle.pid");

export class ChronicleController {
  private child: ChildProcess | null = null;
  private binPath: string | null = null;
  // In-memory mirror of the on-disk "Live Memory enabled" preference. This
  // controller is the only writer of that preference in the main process, so
  // the cache stays authoritative and lets hot callers (the rolling-summary
  // ticks) read enablement every minute without a per-tick disk read.
  private enabledCache: boolean | null = null;

  constructor(private readonly stellaDataDir: string) {}

  // Persist the Live Memory preference and keep the in-memory cache coherent.
  private writeMemoryPreference(pref: {
    enabled: boolean;
    pendingEnable: boolean;
  }): void {
    setChronicleMemoryPreference(this.stellaDataDir, pref);
    this.enabledCache = pref.enabled;
  }

  /**
   * Synchronous, disk-free read of whether Live Memory is currently enabled.
   * Reflects runtime toggles (setEnabled updates the cache), so callers that
   * poll frequently — the chronicle summary ticks — observe an enable/disable
   * that happens mid-session without re-reading preferences.json each time.
   */
  isEnabledCached(): boolean {
    if (this.enabledCache === null) {
      this.enabledCache = getChronicleEnabled(this.stellaDataDir) === true;
    }
    return this.enabledCache;
  }

  private resolveBin(): string | null {
    if (this.binPath) return this.binPath;
    this.binPath = resolveNativeHelperPath("chronicle");
    return this.binPath;
  }

  private async runCommand(
    command: "pause" | "resume" | "stop" | "status" | "ping" | "start",
  ): Promise<string | null> {
    const bin = this.resolveBin();
    if (!bin) return null;
    return await new Promise<string | null>((resolve) => {
      execFile(
        bin,
        [command, "--root", this.stellaDataDir],
        { timeout: 5000 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          resolve(stdout.toString().trim());
        },
      );
    });
  }

  private async waitForDaemonReady(
    timeoutMs = CHRONICLE_STARTUP_TIMEOUT_MS,
  ): Promise<boolean> {
    const startedAt = Date.now();
    // Each ping is a full helper-process spawn (Defender-scanned on Windows),
    // so back off exponentially instead of re-spawning every 150ms.
    let pollMs = CHRONICLE_STARTUP_POLL_MS;
    while (Date.now() - startedAt < timeoutMs) {
      if ((await this.runCommand("ping")) === "pong") {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      pollMs = Math.min(pollMs * 2, CHRONICLE_STARTUP_POLL_MAX_MS);
    }
    return false;
  }

  /**
   * Start the daemon if Chronicle is enabled and the user has granted
   * Screen Recording permission. Safe to call multiple times.
   */
  async start(): Promise<{ started: boolean; reason?: string }> {
    const config = await readConfig(this.stellaDataDir);
    // Live Memory is opt-in: only start when the user has explicitly
    // enabled it. A pending enable (waiting on sign-in)
    // both keep the daemon dormant.
    const enabledNow = getChronicleEnabled(this.stellaDataDir) === true;
    this.enabledCache = enabledNow;
    if (!enabledNow) {
      return { started: false, reason: "disabled" };
    }
    if (process.platform !== "darwin") {
      return { started: false, reason: "unsupported-platform" };
    }
    const bin = this.resolveBin();
    if (!bin) {
      return { started: false, reason: "binary-missing" };
    }
    if (!hasMacPermission("screen", false)) {
      return { started: false, reason: "needs-permission" };
    }

    const pingResult = await this.runCommand("ping");
    if (pingResult === "pong") {
      return { started: true, reason: "already-running" };
    }

    try {
      await fs.mkdir(path.join(this.stellaDataDir, "chronicle"), {
        recursive: true,
      });
    } catch {
      // ignored — daemon will retry creating dirs
    }

    const args = ["daemon", "--root", this.stellaDataDir];
    if (typeof config.intervalMs === "number" && config.intervalMs > 0) {
      args.push("--interval-ms", String(Math.floor(config.intervalMs)));
    }
    if (typeof config.maxStrings === "number" && config.maxStrings > 0) {
      args.push("--max-strings", String(Math.floor(config.maxStrings)));
    }
    for (const bundleId of CHRONICLE_EXCLUDED_BUNDLE_IDS) {
      args.push("--exclude-bundle-id", bundleId);
    }

    const child = spawn(bin, args, {
      detached: true,
      stdio: "ignore",
    });
    this.child = child;
    // Persist the pid so quit can reap the daemon even after the in-memory
    // handle is dropped (spawn error / process restart). Best-effort: a missing
    // pidfile just falls back to the socket stop.
    if (typeof child.pid === "number") {
      try {
        await fs.writeFile(chroniclePidFile(this.stellaDataDir), String(child.pid));
      } catch {
        // ignored — socket stop remains the primary teardown path
      }
    }
    let spawnErrorMessage: string | null = null;
    child.on("error", (error) => {
      spawnErrorMessage = error.message;
      this.child = null;
    });
    child.unref();
    child.on("exit", () => {
      this.child = null;
    });
    if (!(await this.waitForDaemonReady())) {
      await this.stop();
      return {
        started: false,
        reason: spawnErrorMessage ?? "startup-timeout",
      };
    }
    if (spawnErrorMessage) {
      await this.stop();
      return { started: false, reason: spawnErrorMessage };
    }
    return { started: true };
  }

  async pause(): Promise<boolean> {
    return (await this.runCommand("pause")) === "ok";
  }

  async resume(): Promise<boolean> {
    return (await this.runCommand("resume")) === "ok";
  }

  async isEnabled(): Promise<boolean> {
    return getChronicleEnabled(this.stellaDataDir);
  }

  /**
   * Returns true if the user opted in during onboarding but we haven't
   * promoted Live Memory to `enabled` yet because they aren't signed in.
   * Used by the renderer to render a "Sign in to start Live Memory" banner.
   */
  async isPendingEnable(): Promise<boolean> {
    return getChroniclePendingEnable(this.stellaDataDir);
  }

  /**
   * Stage the user's intent to enable Live Memory without actually
   * spawning the daemon. Used during onboarding when the user toggles
   * Live Memory on but isn't signed in. Once the user signs in, the
   * post-onboarding chrome promotes this to a real `setEnabled(true)`.
   */
  async setPendingEnable(pending: boolean): Promise<void> {
    this.writeMemoryPreference({ enabled: false, pendingEnable: pending });
  }

  async status(): Promise<unknown | null> {
    const config = await readConfig(this.stellaDataDir);
    const fps = 1000 / Math.max(config.intervalMs ?? DEFAULT_CHRONICLE_INTERVAL_MS, 1);
    const raw = await this.runCommand("status");
    if (!raw) {
      return {
        running: false,
        paused: false,
        fps,
        lastCaptureAt: null,
      };
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        ...parsed,
        fps,
      };
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    // Primary path: ask the daemon to shut itself down over the socket.
    await this.runCommand("stop");
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignored
      }
    }
    this.child = null;

    // Fallback: if the socket stop didn't actually take the process down (e.g.
    // the daemon was orphaned across a restart, so `this.child` is null), reap
    // the persisted pid — guarded against pid reuse and always dropping the
    // pidfile afterwards. See reapPidfileDaemon.
    await reapPidfileDaemon(chroniclePidFile(this.stellaDataDir), this.resolveBin(), [
      "--root",
      this.stellaDataDir,
    ]);
  }

  /**
   * Toggle Chronicle on/off, persist the choice, and (un)spawn the daemon.
   * Returns the resulting state for the caller to broadcast to the UI.
   */
  async setEnabled(
    enabled: boolean,
  ): Promise<{
    ok: boolean;
    enabled: boolean;
    running: boolean;
    permission: boolean;
    reason?: string;
  }> {
    if (!enabled) {
      // Explicit disable: also clear any staged "pending sign-in" intent.
      this.writeMemoryPreference({
        enabled: false,
        pendingEnable: false,
      });
      await this.stop();
      return {
        ok: true,
        enabled: false,
        running: false,
        permission: hasMacPermission("screen", false),
      };
    }
    if (process.platform !== "darwin") {
      this.writeMemoryPreference({
        enabled: false,
        pendingEnable: false,
      });
      return {
        ok: false,
        enabled: false,
        running: false,
        permission: true,
        reason: "unsupported-platform",
      };
    }
    if (process.platform === "darwin" && !hasMacPermission("screen", false)) {
      const result = await requestMacPermission("screen");
      if (!result.granted) {
        this.writeMemoryPreference({
          enabled: false,
          pendingEnable: false,
        });
        return {
          ok: false,
          enabled: false,
          running: false,
          permission: false,
          reason: "needs-permission",
        };
      }
    }
    // Promote: clear pending intent and mark enabled.
    this.writeMemoryPreference({
      enabled: true,
      pendingEnable: false,
    });
    const startResult = await this.start();
    if (!startResult.started) {
      this.writeMemoryPreference({
        enabled: false,
        pendingEnable: false,
      });
      return {
        ok: false,
        enabled: false,
        running: false,
        permission: hasMacPermission("screen", false),
        reason: startResult.reason ?? "start-failed",
      };
    }
    return {
      ok: true,
      enabled: true,
      running: true,
      permission: hasMacPermission("screen", false),
      ...(startResult.reason ? { reason: startResult.reason } : {}),
    };
  }
}
