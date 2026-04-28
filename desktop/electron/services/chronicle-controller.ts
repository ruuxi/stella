import { spawn, type ChildProcess, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveNativeHelperPath } from "../native-helper-path.js";
import { hasMacPermission, requestMacPermission } from "../utils/macos-permissions.js";

/**
 * ChronicleController owns the lifecycle of the `chronicle` Swift sidecar.
 *
 * Responsibilities:
 *   - Resolve the binary location (dev + packaged)
 *   - Skip cleanly when disabled in `state/config.json` or when Screen
 *     Recording permission is not granted
 *   - Spawn the daemon as a detached process and remember the pid for
 *     status checks
 *   - Send `pause`/`resume`/`stop`/`status` commands over the AF_UNIX socket
 *   - Stop the daemon on app quit
 */

type ChronicleConfig = {
  enabled?: boolean;
  /**
   * The user toggled Live Memory on during onboarding but isn't signed in
   * yet, so we recorded the *intent* without spawning the daemon. Cleared
   * once the user either signs in (we promote it to `enabled: true` and
   * call `start()`) or cancels (we clear it). Treated as opt-out by every
   * lifecycle path until promoted.
   */
  pendingEnable?: boolean;
  intervalMs?: number;
  maxStrings?: number;
};

type StellaConfig = {
  chronicle?: ChronicleConfig;
};

const DEFAULT_CHRONICLE_INTERVAL_MS = 4_000;
const CHRONICLE_STARTUP_TIMEOUT_MS = 3_000;
const CHRONICLE_STARTUP_POLL_MS = 150;
const CHRONICLE_EXCLUDED_BUNDLE_IDS = ["com.stella.app", "com.github.Electron"];

const readConfig = async (stellaHome: string): Promise<ChronicleConfig> => {
  try {
    const raw = await fs.readFile(
      path.join(stellaHome, "state", "config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as StellaConfig;
    return parsed.chronicle ?? {};
  } catch {
    return {};
  }
};

const writeConfigPatch = async (
  stellaHome: string,
  patch: ChronicleConfig,
): Promise<void> => {
  const configPath = path.join(stellaHome, "state", "config.json");
  let current: StellaConfig = {};
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    current = JSON.parse(raw) as StellaConfig;
  } catch {
    current = {};
  }
  const next: StellaConfig = {
    ...current,
    chronicle: { ...(current.chronicle ?? {}), ...patch },
  };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
};

export class ChronicleController {
  private child: ChildProcess | null = null;
  private binPath: string | null = null;

  constructor(private readonly stellaHome: string) {}

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
        [command, "--root", this.stellaHome],
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
    while (Date.now() - startedAt < timeoutMs) {
      if ((await this.runCommand("ping")) === "pong") {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, CHRONICLE_STARTUP_POLL_MS));
    }
    return false;
  }

  /**
   * Start the daemon if Chronicle is enabled and the user has granted
   * Screen Recording permission. Safe to call multiple times.
   */
  async start(): Promise<{ started: boolean; reason?: string }> {
    const config = await readConfig(this.stellaHome);
    // Live Memory is opt-in: only start when the user has explicitly
    // enabled it. Missing config or `pendingEnable` (waiting on sign-in)
    // both keep the daemon dormant.
    if (config.enabled !== true) {
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
      await fs.mkdir(path.join(this.stellaHome, "state", "chronicle"), {
        recursive: true,
      });
    } catch {
      // ignored — daemon will retry creating dirs
    }

    const args = ["daemon", "--root", this.stellaHome];
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
    const config = await readConfig(this.stellaHome);
    return config.enabled === true;
  }

  /**
   * Returns true if the user opted in during onboarding but we haven't
   * promoted Live Memory to `enabled` yet because they aren't signed in.
   * Used by the renderer to render a "Sign in to start Live Memory" banner.
   */
  async isPendingEnable(): Promise<boolean> {
    const config = await readConfig(this.stellaHome);
    return config.enabled !== true && config.pendingEnable === true;
  }

  /**
   * Stage the user's intent to enable Live Memory without actually
   * spawning the daemon. Used during onboarding when the user toggles
   * Live Memory on but isn't signed in. Once the user signs in, the
   * post-onboarding chrome promotes this to a real `setEnabled(true)`.
   */
  async setPendingEnable(pending: boolean): Promise<void> {
    if (pending) {
      await writeConfigPatch(this.stellaHome, {
        enabled: false,
        pendingEnable: true,
      });
    } else {
      await writeConfigPatch(this.stellaHome, { pendingEnable: false });
    }
  }

  async status(): Promise<unknown | null> {
    const config = await readConfig(this.stellaHome);
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
    await this.runCommand("stop");
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignored
      }
    }
    this.child = null;
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
      await writeConfigPatch(this.stellaHome, {
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
      await writeConfigPatch(this.stellaHome, {
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
        await writeConfigPatch(this.stellaHome, {
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
    await writeConfigPatch(this.stellaHome, {
      enabled: true,
      pendingEnable: false,
    });
    const startResult = await this.start();
    if (!startResult.started) {
      await writeConfigPatch(this.stellaHome, {
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
