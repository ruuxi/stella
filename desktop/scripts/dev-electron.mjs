/**
 * Electron process lifecycle for the dev/production runner: prepares the
 * macOS Stella.app dev bundle, terminates stale app trees, launches Electron
 * once Vite + the electron bundles are ready, and restarts it when
 * restart-relevant build outputs genuinely change (content-hash gated).
 *
 * Runs in-process inside `electron-dev-runner.mjs` (the single supervisor
 * process) — import `startElectronLifecycle` rather than spawning this file.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  watch,
} from "node:fs";
import { resolve } from "node:path";
import path from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { shouldRestartElectronForBuildPath } from "./dev-electron-restart-filter.mjs";
import {
  classifyElectronExit,
  shouldSuppressWatcherRestart,
} from "./dev-electron-exit-policy.mjs";
import {
  prepareMacDevAppBundle,
  resolveDisclaimBinary,
} from "./lib/macos-dev-app.mjs";
import { prepareWinDevAppExecutable } from "./lib/windows-dev-app.mjs";

const require = createRequire(import.meta.url);
const DEV_MACOS_RUNTIME_DIR_NAME = ".stella-dev-runtime";
const DEV_BARE_RELAUNCH_EXECUTABLE = "StellaDevRelaunch";
const LEGACY_DEV_PROTOCOL_APP_NAME = "stella-dev-protocol-app";
const scriptDir = import.meta.dirname;
const desktopDir = resolve(scriptDir, "..");
const repoRootDir = resolve(desktopDir, "..");
const watchedDir = path.join(desktopDir, "dist-electron");
const runtimeReloadStateFile = path.join(
  repoRootDir,
  ".stella-runtime-reload-state.json",
);
const devRestartRequestFile = path.join(
  repoRootDir,
  ".stella-dev-restart-request",
);
const devUserQuitRequestFile = path.join(
  repoRootDir,
  ".stella-dev-user-quit-request",
);
// Records the pid of the currently-launched Electron app so the next dev
// start can reap a leftover tree. On macOS `terminateStaleDevApps` scans
// `ps` by image path; Windows has no cheap image-path scan, so we persist
// the pid and `taskkill /T` it on the next launch instead.
const devAppPidFile = path.join(desktopDir, ".electron-dev-app.pid");
const devRuntimeRoot = path.join(desktopDir, DEV_MACOS_RUNTIME_DIR_NAME);
const legacyRuntimeElectronBinary = path.join(
  devRuntimeRoot,
  "Stella.app",
  "Contents",
  "MacOS",
  "Electron",
);
const devUrlFile = path.join(desktopDir, ".vite-dev-url");
const restartDebounceMs = 150;
const devRestartRequestGraceMs = 2_000;
const buildOutputSettleQuietMs = 350;
const buildOutputSettleTimeoutMs = 5_000;
const forcedShutdownTimeoutMs = 1_500;
const startupWatchDelayMs = 2_500;
const staleAppShutdownPollMs = 150;
const staleAppShutdownTimeoutMs = 3_000;
const devUrlFileWaitTimeoutMs = 10_000;

const logError = (message) => {
  console.error(`[electron-main] ${message}`);
};

const wait = (ms) =>
  new Promise((resolveWait) => {
    setTimeout(resolveWait, ms);
  });

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Code-signing identity of the packaged Stella launcher.
const LAUNCHER_TEAM_ID = "7UVYHQ763X";
const LAUNCHER_BUNDLE_ID = "com.stella.launcher";
// Pins both the bundle id and the Stella team via the Apple-rooted chain.
const LAUNCHER_CODESIGN_REQUIREMENT = `anchor apple generic and identifier "${LAUNCHER_BUNDLE_ID}" and certificate leaf[subject.OU] = "${LAUNCHER_TEAM_ID}"`;

/**
 * Verify a candidate launcher's `.app` bundle is a genuine, intact Stella
 * launcher: a valid code seal (`--verify --strict`) that also satisfies a
 * Developer-ID requirement pinning the bundle id + team. `-dvv` alone only
 * prints the embedded descriptor without validating the seal — a tampered
 * binary still carrying the team id would pass it — so this actually enforces
 * trust before the binary is spawned to decrypt at-rest BYOK keys.
 *
 * @param {string} appBundlePath
 * @returns {{ trusted: true } | { trusted: false; reason: string }}
 */
const verifyLauncherBundle = (appBundlePath) => {
  try {
    execFileSync(
      "codesign",
      [
        "--verify",
        "--strict",
        "-R",
        `=${LAUNCHER_CODESIGN_REQUIREMENT}`,
        appBundlePath,
      ],
      { stdio: "ignore" },
    );
    return { trusted: true };
  } catch (error) {
    if (error?.code === "ENOENT") {
      // `codesign` is a base macOS binary; its absence is unusual and not the
      // launcher's fault, so report it distinctly from a failed verification.
      return { trusted: false, reason: "codesign unavailable" };
    }
    return {
      trusted: false,
      reason: "code signature / requirement check failed",
    };
  }
};

/**
 * Locate the installed, signed Stella launcher binary so the dev runtime can
 * decrypt launcher-keychain credentials (e.g. BYOK API keys saved while
 * running under the packaged launcher). The dev server is never itself
 * packaged, so without this it falls back to insecure dev-plaintext storage
 * and silently can't read keys the launcher wrote — routing then drops to the
 * managed relay. Returns null when no trusted launcher is installed (e.g. CI),
 * leaving the existing dev-plaintext fallback intact.
 *
 * @returns {string | null}
 */
const resolveLauncherProtectedStorageBin = () => {
  const fromEnv = process.env.STELLA_LAUNCHER_PROTECTED_STORAGE_BIN?.trim();
  if (fromEnv) {
    // Authoritative: the packaged launcher passes its own exact binary path
    // when it spawns dev. Trust it as-is — a local/dev (ad-hoc) launcher build
    // would not satisfy the Developer-ID requirement below.
    return fromEnv;
  }
  if (process.platform !== "darwin") {
    return null;
  }
  const candidates = [
    "/Applications/Stella.app/Contents/MacOS/Stella",
    path.join(
      homedir(),
      "Applications",
      "Stella.app",
      "Contents",
      "MacOS",
      "Stella",
    ),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const appBundle = path.resolve(candidate, "..", "..", "..");
    const verdict = verifyLauncherBundle(appBundle);
    if (verdict.trusted) {
      return candidate;
    }
    // Surface why a present-but-rejected launcher isn't being used, instead of
    // silently dropping to insecure dev-plaintext storage.
    console.warn(
      `[electron-main] ignoring launcher at ${appBundle}: ${verdict.reason}. ` +
        "BYOK keys saved under the launcher won't decrypt; dev will use insecure dev-plaintext storage.",
    );
  }
  return null;
};

/**
 * Decide how the spawned runtime stores secrets at rest. The result is merged
 * onto the child's environment:
 * - A trusted launcher binary → broker through it. On macOS the launcher owns
 *   the Keychain ACL, so dev-Electron decrypts without a Keychain prompt.
 * - Windows (no launcher) → fall through to Electron `safeStorage` (DPAPI) by
 *   NOT setting the insecure flag. DPAPI is user-scoped with no per-app prompt,
 *   so bare dev encrypts directly — no launcher needed.
 * - Otherwise (macOS without a launcher, Linux) → dev-plaintext, because
 *   `safeStorage` there would surface an OS keyring prompt a dev build's
 *   identity can't satisfy.
 *
 * @param {string | null} launcherBin
 * @returns {Record<string, string>}
 */
const resolveProtectedStorageEnv = (launcherBin) => {
  if (launcherBin) {
    return { STELLA_LAUNCHER_PROTECTED_STORAGE_BIN: launcherBin };
  }
  if (process.platform === "win32") {
    return {};
  }
  return { STELLA_DEV_INSECURE_PROTECTED_STORAGE: "1" };
};

/**
 * Starts the Electron lifecycle.
 *
 * @param {object} options
 * @param {Promise<void>} options.readiness resolves when Vite is listening and
 *   the electron bundles are fresh — Electron is only spawned after it.
 * @param {Record<string, string>} [options.electronEnv] extra env for the
 *   spawned Electron process (e.g. its dedicated NODE_COMPILE_CACHE dir).
 * @param {(code: number) => void} options.onExit invoked after internal
 *   cleanup when Electron exits without a restart request.
 * @returns {{ stop: () => Promise<void> }}
 */
export const startElectronLifecycle = ({ readiness, electronEnv, onExit }) => {
  let electronBinary = require("electron");

  // Discover the installed launcher binary so launcher-keychain credentials
  // (BYOK keys) decrypt in the dev runtime. Computed once per lifecycle and
  // shared by both the in-process spawn and the bare relaunch shell script.
  const launcherProtectedStorageBin = resolveLauncherProtectedStorageBin();
  if (launcherProtectedStorageBin) {
    console.log(
      `[electron-main] protected storage via launcher: ${launcherProtectedStorageBin}`,
    );
  } else if (process.platform === "win32") {
    console.log(
      "[electron-main] protected storage via OS safeStorage (DPAPI)",
    );
  }

  let shuttingDown = false;
  let currentApp = null;
  let restartTimer = null;
  let watcher = null;
  let restartQueue = Promise.resolve();
  let watchReady = false;
  let watchReadyTimer = null;
  let restartRequestedByWatcher = false;
  let rootWatcher = null;
  let pendingRestartWhilePaused = false;
  const expectedExits = new WeakSet();

  /**
   * Last-seen `{ size, mtimeMs, hash }` fingerprint for every restart-relevant
   * build output under `dist-electron/`. The fs watcher fires on mtime/write
   * events; without a content gate a byte-identical rewrite would tear down
   * Electron (and the in-flight self-mod morph cover with it) for nothing.
   * The `hash` stays the source of truth for the gate; the `size`/`mtimeMs`
   * pair is only a cheap pre-check that lets us skip re-reading multi-MB
   * outputs when stat proves the file is unchanged.
   *
   * `null` here means "the file has been deleted"; `undefined` means
   * "we have not seen this path before".
   */
  const lastBuildHashes = new Map();

  const readHash = (filePath) => {
    if (!existsSync(filePath)) {
      return null;
    }
    return createHash("md5").update(readFileSync(filePath)).digest("hex");
  };

  // Cheap stat fingerprint used to short-circuit the multi-MB content read when
  // size+mtime prove the file is unchanged since we last hashed it. Returns null
  // when the file is missing (mirrors readHash's deletion semantics).
  const readBuildStat = (filePath) => {
    try {
      const stats = statSync(filePath);
      return { size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
      return null;
    }
  };

  const getLatestRestartRelevantBuildMtimeMs = () => {
    let latestMtimeMs = 0;
    const visit = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(absPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const relPath = path.relative(watchedDir, absPath);
        if (!shouldRestartElectronForBuildPath(relPath)) continue;
        try {
          latestMtimeMs = Math.max(latestMtimeMs, statSync(absPath).mtimeMs);
        } catch {
          // Ignore files that disappear while esbuild is rewriting the tree.
        }
      }
    };
    visit(watchedDir);
    return latestMtimeMs;
  };

  const waitForBuildOutputsToSettle = async () => {
    const startedAt = Date.now();
    while (!shuttingDown) {
      const latestMtimeMs = getLatestRestartRelevantBuildMtimeMs();
      if (
        latestMtimeMs === 0 ||
        Date.now() - latestMtimeMs >= buildOutputSettleQuietMs
      ) {
        return;
      }
      if (Date.now() - startedAt >= buildOutputSettleTimeoutMs) {
        return;
      }
      await wait(75);
    }
  };

  /**
   * Walk `dist-electron/` once at startup and record the hash of every
   * file matching the restart filter, so the first watcher events after a
   * launch don't look like "first sighting" and trip a restart when the
   * bytes haven't changed.
   */
  const seedLastBuildHashes = () => {
    const visit = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const absPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(absPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const relPath = path.relative(watchedDir, absPath);
        if (!shouldRestartElectronForBuildPath(relPath)) continue;
        const hash = readHash(absPath);
        if (hash == null) continue;
        const stat = readBuildStat(absPath);
        lastBuildHashes.set(absPath, {
          hash,
          size: stat?.size,
          mtimeMs: stat?.mtimeMs,
        });
      }
    };
    visit(watchedDir);
  };

  const ensureDevBareRelaunchExecutable = (electronBinaryPath) => {
    if (process.platform !== "darwin") {
      return false;
    }

    let changed = false;
    const contentsDir = path.resolve(path.dirname(electronBinaryPath), "..");
    const infoPlist = path.join(contentsDir, "Info.plist");
    const macosDir = path.join(contentsDir, "MacOS");
    const relaunchExecutablePath = path.join(
      macosDir,
      DEV_BARE_RELAUNCH_EXECUTABLE,
    );
    const resourcesAppDir = path.join(contentsDir, "Resources", "app");
    const resourcesAppPackageJson = path.join(resourcesAppDir, "package.json");

    try {
      if (existsSync(resourcesAppPackageJson)) {
        const packageJson = JSON.parse(
          readFileSync(resourcesAppPackageJson, "utf8"),
        );
        const knownShimNames = new Set([
          LEGACY_DEV_PROTOCOL_APP_NAME,
          "stella-dev-bare-relaunch-app",
        ]);
        if (knownShimNames.has(packageJson?.name)) {
          rmSync(resourcesAppDir, { force: true, recursive: true });
          changed = true;
        }
      }

      const relaunchScript = `#!/bin/zsh
set -e

repo_root=${JSON.stringify(repoRootDir)}
electron_bin="$(cd "$(dirname "$0")" && pwd)/Electron"
restart_file=${JSON.stringify(devRestartRequestFile)}
runner_pid_file=${JSON.stringify(path.join(desktopDir, ".electron-dev-runner.pid"))}
runner_script=${JSON.stringify(path.join(desktopDir, "scripts", "electron-dev-runner.mjs"))}
node_bin=${JSON.stringify(process.execPath)}
launcher_protected_storage_bin=${JSON.stringify(launcherProtectedStorageBin ?? "")}

non_launch_args=()
for arg in "$@"; do
  case "$arg" in
    -psn_*) ;;
    *) non_launch_args+=("$arg") ;;
  esac
done

if [ "\${#non_launch_args[@]}" -eq 0 ]; then
  runner_pid=""
  if [ -f "$runner_pid_file" ]; then
    runner_pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$runner_pid_file" | head -n 1)"
  fi

  if [ -n "$runner_pid" ] && kill -0 "$runner_pid" 2>/dev/null; then
    date +%s > "$restart_file"
    exit 0
  fi

  cd "$repo_root"
  exec "$node_bin" "$runner_script"
fi

cd "$repo_root"
if [ "\${non_launch_args[1]-}" != "." ]; then
  non_launch_args=("." "\${non_launch_args[@]}")
fi
export NODE_ENV=development
export STELLA_DEV_RESTART_REQUEST_FILE="$restart_file"
if [ -z "$STELLA_LAUNCHER_PROTECTED_STORAGE_BIN" ] && [ -n "$launcher_protected_storage_bin" ]; then
  export STELLA_LAUNCHER_PROTECTED_STORAGE_BIN="$launcher_protected_storage_bin"
fi
if [ -z "$STELLA_LAUNCHER_PROTECTED_STORAGE_BIN" ]; then
  export STELLA_DEV_INSECURE_PROTECTED_STORAGE=1
fi
exec "$electron_bin" "\${non_launch_args[@]}"
`;

      if (
        !existsSync(relaunchExecutablePath) ||
        readFileSync(relaunchExecutablePath, "utf8") !== relaunchScript
      ) {
        writeFileSync(relaunchExecutablePath, relaunchScript, "utf8");
        changed = true;
      }
      try {
        const mode = statSync(relaunchExecutablePath).mode & 0o777;
        if (mode !== 0o755) {
          chmodSync(relaunchExecutablePath, 0o755);
          changed = true;
        }
      } catch {
        chmodSync(relaunchExecutablePath, 0o755);
        changed = true;
      }

      if (existsSync(infoPlist)) {
        let currentExecutable = "";
        try {
          currentExecutable = execFileSync(
            "plutil",
            ["-extract", "CFBundleExecutable", "raw", infoPlist],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          ).trim();
        } catch {
          // Missing key or unexpected plist; fall through to replace it.
        }
        if (currentExecutable !== DEV_BARE_RELAUNCH_EXECUTABLE) {
          execFileSync(
            "plutil",
            [
              "-replace",
              "CFBundleExecutable",
              "-string",
              DEV_BARE_RELAUNCH_EXECUTABLE,
              infoPlist,
            ],
            { stdio: "ignore" },
          );
          changed = true;
        }
      }
    } catch {
      // Best-effort; may fail if node_modules is read-only.
    }
    return changed;
  };

  // Give the dev Electron bundle the Stella.app identity (icon, name,
  // signature) so the Dock shows Stella, then resolve `disclaim-spawn` so the
  // launched process adopts that identity. The bare-relaunch shim is
  // bundle-specific to this launcher, so it rides along as an extra patch
  // under the same re-sign.
  if (process.platform === "darwin") {
    const prepared = prepareMacDevAppBundle({
      electronBinary,
      desktopDir,
      extraPatches: (electronBinaryPath) =>
        ensureDevBareRelaunchExecutable(electronBinaryPath),
    });
    electronBinary = prepared.electronBinary;
  }

  // Windows equivalent: brand a `Stella.exe` copy of the stock binary so the
  // exe identity itself carries the Stella icon for the taskbar, alt-tab,
  // and tray — independent of AppUserModelID/shortcut resolution timing.
  if (process.platform === "win32") {
    electronBinary = prepareWinDevAppExecutable({ electronBinary, desktopDir });
  }

  const disclaimBinary =
    process.platform === "darwin"
      ? resolveDisclaimBinary({ desktopDir })
      : null;

  const listStaleDevAppPids = () => {
    if (process.platform !== "darwin") {
      return [];
    }

    try {
      const stdout = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
        encoding: "utf8",
      });
      const candidateCommands = new Set([
        electronBinary,
        legacyRuntimeElectronBinary,
        electronBinary.replace("/Stella.app/", "/Electron.app/"),
      ]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          const match = line.match(/^(\d+)\s+(.*)$/);
          if (!match) {
            return [];
          }

          const pid = Number(match[1]);
          const command = match[2] ?? "";
          if (!Number.isInteger(pid) || pid === process.pid) {
            return [];
          }

          for (const candidateCommand of candidateCommands) {
            const expectedCommandPrefix = `${candidateCommand} `;
            if (
              command === candidateCommand ||
              command === `${candidateCommand} .` ||
              command.startsWith(expectedCommandPrefix)
            ) {
              return [pid];
            }
          }

          return [];
        });
    } catch {
      return [];
    }
  };

  const readDevAppPid = () => {
    try {
      const pid = Number.parseInt(
        readFileSync(devAppPidFile, "utf8").trim(),
        10,
      );
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  };

  const writeDevAppPid = (pid) => {
    try {
      writeFileSync(devAppPidFile, String(pid), "utf8");
    } catch {
      // Best-effort; without it the next start just can't reap this pid.
    }
  };

  const clearDevAppPid = () => {
    try {
      rmSync(devAppPidFile, { force: true });
    } catch {
      // Ignore stale/missing pid files during shutdown.
    }
  };

  // Confirm a recorded pid still belongs to Electron before killing its tree,
  // guarding against pid reuse. `tasklist` with a single PID filter is cheap
  // (no full WMI/CIM enumeration), unlike the PowerShell scans elsewhere.
  const isWindowsPidElectron = (pid) => {
    try {
      const out = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
        { encoding: "utf8", windowsHide: true },
      ).toLowerCase();
      return out.includes("electron.exe") || out.includes("stella");
    } catch {
      return false;
    }
  };

  const terminateStaleWindowsDevApp = async () => {
    const pid = readDevAppPid();
    if (
      pid === null ||
      pid === process.pid ||
      !isPidAlive(pid) ||
      !isWindowsPidElectron(pid)
    ) {
      clearDevAppPid();
      return;
    }

    logError(
      `found stale dev Electron process (${pid}); terminating tree before launch.`,
    );
    await new Promise((resolveKill) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => resolveKill());
      killer.on("exit", () => resolveKill());
    });
    clearDevAppPid();
  };

  // SIGTERM-then-SIGKILL a detached app's process group (it is its own group
  // leader because startApp spawns it detached), mirroring the escalation used
  // for the full ps-scan path below.
  const terminateDarwinPidTree = async (pid) => {
    const signalGroup = (signal) => {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fall back to the direct pid if the group send fails (e.g. the
        // leader already exited but a child lingers).
      }
      try {
        process.kill(pid, signal);
      } catch {
        // Ignore races if the process already exited.
      }
    };

    signalGroup("SIGTERM");

    const deadline = Date.now() + staleAppShutdownTimeoutMs;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) {
        return;
      }
      await wait(staleAppShutdownPollMs);
    }

    if (isPidAlive(pid)) {
      signalGroup("SIGKILL");
    }
  };

  const terminateStaleDevApps = async () => {
    if (process.platform === "win32") {
      await terminateStaleWindowsDevApp();
      return;
    }

    // Fast path: a clean restart writes the launched app's pid and clears it on
    // a clean exit, so a surviving pid file points straight at the stale tree.
    // Terminate just that pid tree and skip the full `ps -ax` image-path scan.
    // Only fall back to the scan when the pid file is absent — matching the
    // sibling runner's "unexpected absence means something leaked" heuristic.
    const recordedPid = readDevAppPid();
    if (recordedPid !== null) {
      if (recordedPid !== process.pid && isPidAlive(recordedPid)) {
        logError(
          `found stale dev Stella process (${recordedPid}); terminating tree before launch.`,
        );
        await terminateDarwinPidTree(recordedPid);
      }
      clearDevAppPid();
      return;
    }

    const stalePids = listStaleDevAppPids();
    if (stalePids.length === 0) {
      return;
    }

    logError(
      `found stale dev Stella process${stalePids.length === 1 ? "" : "es"} (${stalePids.join(", ")}); terminating before launch.`,
    );

    for (const pid of stalePids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Ignore races if a stale process exits before termination.
      }
    }

    const deadline = Date.now() + staleAppShutdownTimeoutMs;
    while (Date.now() < deadline) {
      const remaining = stalePids.filter((pid) => isPidAlive(pid));
      if (remaining.length === 0) {
        return;
      }
      await wait(staleAppShutdownPollMs);
    }

    for (const pid of stalePids) {
      if (!isPidAlive(pid)) {
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore races if a stale process exits during escalation.
      }
    }
  };

  const isRuntimeReloadPaused = () => {
    if (!existsSync(runtimeReloadStateFile)) {
      return false;
    }
    try {
      const raw = JSON.parse(readFileSync(runtimeReloadStateFile, "utf8"));
      return raw?.paused === true && isPidAlive(Number(raw?.pid));
    } catch {
      return false;
    }
  };

  const consumeDevRestartRequest = () => {
    if (!existsSync(devRestartRequestFile)) {
      return false;
    }

    try {
      rmSync(devRestartRequestFile, { force: true });
    } catch {
      // If cleanup races with process exit, the next restart cycle can consume it.
    }
    return true;
  };

  const hasDevUserQuitRequest = () => existsSync(devUserQuitRequestFile);

  const waitForDevRestartRequest = async () => {
    const deadline = Date.now() + devRestartRequestGraceMs;
    while (!shuttingDown && Date.now() < deadline) {
      if (consumeDevRestartRequest()) {
        return true;
      }
      await wait(100);
    }
    return false;
  };

  const flushDeferredRestartIfReady = () => {
    if (!pendingRestartWhilePaused || shuttingDown || isRuntimeReloadPaused()) {
      return;
    }
    pendingRestartWhilePaused = false;
    restartRequestedByWatcher = true;
    scheduleRestart();
  };

  const startApp = () => {
    if (shuttingDown || currentApp) {
      return;
    }

    rmSync(devUserQuitRequestFile, { force: true });

    const useDisclaim = disclaimBinary && existsSync(disclaimBinary);
    const spawnCmd = useDisclaim ? disclaimBinary : electronBinary;
    const spawnArgs = useDisclaim ? [electronBinary, "."] : ["."];

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: repoRootDir,
      env: {
        ...process.env,
        NODE_ENV: "development",
        STELLA_DEV_RESTART_REQUEST_FILE: devRestartRequestFile,
        STELLA_DEV_USER_QUIT_REQUEST_FILE: devUserQuitRequestFile,
        ...resolveProtectedStorageEnv(launcherProtectedStorageBin),
        ...(electronEnv ?? {}),
      },
      stdio: "inherit",
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    currentApp = child;
    if (child.pid) {
      writeDevAppPid(child.pid);
    }

    child.once("error", () => {
      if (currentApp === child) {
        currentApp = null;
      }

      if (!shuttingDown && restartRequestedByWatcher) {
        scheduleRestart();
      }
    });

    child.once("exit", async (code, signal) => {
      if (currentApp === child) {
        currentApp = null;
      }

      if (shuttingDown || expectedExits.has(child)) {
        return;
      }

      const immediateRestartRequest = consumeDevRestartRequest();
      const exitAction = classifyElectronExit({
        code,
        signal,
        explicitRestartRequested: immediateRestartRequest,
        watcherRestartRequested: restartRequestedByWatcher,
      });
      if (exitAction === "restart") {
        restartRequestedByWatcher = true;
        scheduleRestart();
        return;
      }

      // A clean app quit wins over a deferred watcher restart. Still allow the
      // explicit relaunch IPC a short grace window in case its marker write and
      // the child exit race at the filesystem boundary.
      if (await waitForDevRestartRequest()) {
        restartRequestedByWatcher = true;
        scheduleRestart();
        return;
      }

      const exitCode = code ?? 1;
      logError(
        `electron-main exited ${signal ? `via ${signal}` : `with code ${code ?? 0}`} without a watched build change; stopping electron dev.`,
      );
      void shutdown(exitCode);
    });
  };

  const stopApp = async () => {
    const child = currentApp;
    if (!child) {
      return;
    }

    currentApp = null;
    expectedExits.add(child);

    await new Promise((resolveStop) => {
      let settled = false;

      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        resolveStop();
      };

      const signalAppProcess = (signal) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        if (process.platform !== "win32") {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back to the direct child below.
          }
        }
        try {
          child.kill(signal);
        } catch {
          // Ignore races during shutdown.
        }
      };

      child.once("exit", finish);
      signalAppProcess("SIGTERM");

      setTimeout(() => {
        if (settled) {
          return;
        }

        signalAppProcess("SIGKILL");
        finish();
      }, forcedShutdownTimeoutMs).unref();
    });
  };

  const scheduleRestart = () => {
    if (shuttingDown) {
      return;
    }

    if (restartTimer) {
      clearTimeout(restartTimer);
    }

    restartTimer = setTimeout(() => {
      restartTimer = null;
      restartQueue = restartQueue
        .catch(() => undefined)
        .then(async () => {
          if (
            shouldSuppressWatcherRestart({
              userQuitRequested: hasDevUserQuitRequest(),
              explicitRestartRequested: existsSync(devRestartRequestFile),
            })
          ) {
            return;
          }
          await stopApp();
          await waitForBuildOutputsToSettle();
          // A restart-relevant change set can also rewrite vite.config.ts
          // (e.g. a desktop update), which makes Vite restart its server and
          // unlink `.vite-dev-url` until the new server is listening. Electron
          // reads that file synchronously at bootstrap, so spawning inside the
          // unlink window crashes main with ENOENT — wait it out first.
          await waitForDevUrlFile();
          if (!shuttingDown) {
            restartRequestedByWatcher = false;
            startApp();
          }
        });
    }, restartDebounceMs);
  };

  const scheduleWatchReady = () => {
    if (watchReadyTimer) {
      clearTimeout(watchReadyTimer);
    }

    watchReadyTimer = setTimeout(() => {
      watchReady = true;
      watchReadyTimer = null;
    }, startupWatchDelayMs);
  };

  const cleanup = async () => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }

    if (watchReadyTimer) {
      clearTimeout(watchReadyTimer);
      watchReadyTimer = null;
    }

    watcher?.close();
    rootWatcher?.close();
    await stopApp();
    clearDevAppPid();
  };

  const shutdown = async (exitCode) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await cleanup();
    onExit(exitCode);
  };

  const stop = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await cleanup();
  };

  const waitForDevUrlFile = async () => {
    const deadline = Date.now() + devUrlFileWaitTimeoutMs;
    while (!shuttingDown && Date.now() < deadline) {
      if (existsSync(devUrlFile)) {
        return;
      }
      await wait(50);
    }
    if (!shuttingDown) {
      logError(
        `.vite-dev-url did not reappear within ${devUrlFileWaitTimeoutMs}ms — the in-process Vite restart likely hung or failed; Electron will crash at bootstrap without it.`,
      );
    }
  };

  const run = async () => {
    await readiness;
    // The dev-url plugin writes the file on the http server's `listening`
    // event, which fires before `server.listen()` resolves — this poll is a
    // cheap belt-and-suspenders for that ordering.
    await waitForDevUrlFile();
    if (shuttingDown) {
      return;
    }

    await terminateStaleDevApps();

    seedLastBuildHashes();
    await waitForBuildOutputsToSettle();
    if (shuttingDown) {
      return;
    }

    watcher = watch(watchedDir, { recursive: true }, (_eventType, filename) => {
      if (!shouldRestartElectronForBuildPath(filename)) {
        return;
      }

      // Content gate: only honor the watcher tick when the file's bytes
      // actually changed. Restarting Electron on byte-identical rewrites is
      // the visible failure that kills self-mod morph covers.
      const absPath = path.join(watchedDir, filename);
      const previousEntry = lastBuildHashes.has(absPath)
        ? lastBuildHashes.get(absPath)
        : undefined;
      // Cheap stat pre-check: when size+mtime are byte-for-byte the same as
      // the last entry we recorded, the content is unchanged, so skip the
      // multi-MB re-read entirely. Only when stat differs do we fall back to
      // hashing, which still suppresses byte-identical rewrites that bump
      // only mtime.
      if (
        previousEntry != null &&
        previousEntry.mtimeMs !== undefined &&
        previousEntry.size !== undefined
      ) {
        const currentStat = readBuildStat(absPath);
        if (
          currentStat &&
          currentStat.size === previousEntry.size &&
          currentStat.mtimeMs === previousEntry.mtimeMs
        ) {
          return;
        }
      }
      const currentHash = readHash(absPath);
      const previousHash =
        previousEntry === undefined ? undefined : (previousEntry?.hash ?? null);
      if (previousHash !== undefined && currentHash === previousHash) {
        return;
      }
      const currentStat = currentHash == null ? null : readBuildStat(absPath);
      lastBuildHashes.set(
        absPath,
        currentHash == null
          ? null
          : {
              hash: currentHash,
              size: currentStat?.size,
              mtimeMs: currentStat?.mtimeMs,
            },
      );

      // Reaching here means the content gate confirmed a genuine byte change
      // (or a brand-new restart-relevant output). A change inside the startup
      // `watchReady` window means Electron launched against artifacts that an
      // in-flight rebuild just refreshed — honor it instead of swallowing it,
      // otherwise stale main/preload code keeps running with no auto-restart.
      if (!watchReady) {
        scheduleWatchReady();
      }

      if (isRuntimeReloadPaused()) {
        pendingRestartWhilePaused = true;
        return;
      }

      restartRequestedByWatcher = true;
      scheduleRestart();
    });

    rootWatcher = watch(repoRootDir, (_eventType, filename) => {
      if (
        typeof filename !== "string" ||
        filename !== path.basename(runtimeReloadStateFile)
      ) {
        return;
      }
      flushDeferredRestartIfReady();
    });

    startApp();
    scheduleWatchReady();
  };

  void run().catch((error) => {
    logError(
      `electron lifecycle failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    void shutdown(1);
  });

  return { stop };
};
