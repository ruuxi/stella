/**
 * Single-process supervisor for the dev/production launch path
 * (`bun run electron:dev`).
 *
 * Historically this spawned three sibling Node processes (Vite dev server,
 * esbuild watch service, Electron launcher) that were semantically one
 * failure unit — any child exiting tore down the rest. They now run inside
 * this one process:
 *
 *   - Vite is hosted in-process via its JS API (`createServer`), sharing this
 *     process's heap instead of paying a second Node runtime.
 *   - The electron bundles build on demand (startup freshness check + bare
 *     fs.watch over their source roots) via `dev-electron-build.mjs`; no
 *     esbuild watch contexts or resident service process.
 *   - The Electron child lifecycle (spawn, content-gated restarts, stale-app
 *     reaping) runs via `dev-electron.mjs`.
 *
 * Electron itself stays a separate child process, so Electron restarts never
 * disturb the Vite server or the worker.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  ensureElectronBinary,
  isElectronBinaryHealthy,
} from "./ensure-electron-binary.mjs";
import {
  ensureElectronBundlesFresh,
  watchElectronBundleSources,
} from "./dev-electron-build.mjs";
import { startElectronLifecycle } from "./dev-electron.mjs";

const scriptDir = import.meta.dirname;
const desktopDir = resolve(scriptDir, "..");
const repoRootDir = resolve(desktopDir, "..");
const viteBinPath = resolve(
  repoRootDir,
  "node_modules",
  "vite",
  "bin",
  "vite.js",
);
const viteConfigPath = resolve(desktopDir, "vite.config.ts");
const viteDevUrlPath = resolve(desktopDir, ".vite-dev-url");
const pidFilePath = resolve(desktopDir, ".electron-dev-runner.pid");
const readyFilePath = resolve(desktopDir, ".electron-dev-runner.ready");

// The whole launch stack (Vite server, bundle builds, Electron child) runs in
// development mode; the previous multi-process runner set this on the Vite
// child's env, and the in-process server reads it the same way.
process.env.NODE_ENV = "development";

const ensureCacheDir = (dir) => {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort; if the cache dir can't be created we simply forgo the
    // compile-cache speedup rather than fail dev startup.
  }
};
// Stable per-repo V8 bytecode cache for the electron-main bundle. Lives
// OUTSIDE dist-electron so esbuild's clean + identical-byte rewrites do not
// invalidate it; reused across launches and self-mod restarts so Node's V8
// engine skips re-parsing/compiling the bundle every time.
const v8CompileCacheDir = resolve(
  repoRootDir,
  ".stella-dev",
  "v8-compile-cache",
);
ensureCacheDir(v8CompileCacheDir);
// Node's NODE_COMPILE_CACHE writes per-Node-version subdirs named like
// `v<node>-<arch>-<hash>-<uid>` and never reclaims the ones left behind by a
// prior Node upgrade. Those stale trees (thousands of cache files each) only
// grow on disk and are never read again, so prune any subdir whose
// `v<node>-<arch>` prefix doesn't match this process. One-time readdir + rm on
// startup; best-effort so a cleanup error never blocks dev launch.
try {
  const currentCacheVersionPrefix = `v${process.versions.node}-${process.arch}`;
  for (const entry of readdirSync(v8CompileCacheDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith(`${currentCacheVersionPrefix}-`)) {
      continue;
    }
    try {
      rmSync(resolve(v8CompileCacheDir, entry.name), {
        force: true,
        recursive: true,
      });
    } catch {
      // Best-effort per-entry prune; skip anything we can't remove.
    }
  }
} catch {
  // Best-effort; a missing/unreadable cache dir just means nothing to prune.
}
// Dedicated V8 bytecode cache for this supervisor process (which hosts Vite
// in-process), kept separate from the electron-main cache so the two don't
// churn one shared dir. Enabled programmatically since the launcher spawns us
// without NODE_COMPILE_CACHE; guarded because Bun's node:module shim may not
// implement it.
const viteCompileCacheDir = resolve(
  repoRootDir,
  ".stella-dev",
  "vite-compile-cache",
);
ensureCacheDir(viteCompileCacheDir);
try {
  const { enableCompileCache } = await import("node:module");
  enableCompileCache?.(viteCompileCacheDir);
} catch {
  // Compile cache is an optimization only.
}

// Old runner versions ran Vite and the Electron launcher as separate spawned
// scripts; keep their command needles so an upgrade over an unclean shutdown
// still reaps that generation's orphans.
const managedScriptPaths = [
  resolve(scriptDir, "dev-electron-build.mjs"),
  resolve(scriptDir, "dev-electron.mjs"),
];
const managedCommandNeedles = [viteBinPath, ...managedScriptPaths];

if (!existsSync(viteBinPath)) {
  console.error(
    `[electron:dev] Missing Vite at ${viteBinPath}. Run \`bun install\` at the repo root first.`,
  );
  process.exit(1);
}

// Repair a half-extracted Electron binary before launching electron-main, so a
// broken install self-heals on `bun run electron:dev` without a fresh install.
// The check is cheap (a couple file reads) and only re-extracts when broken.
if (!isElectronBinaryHealthy()) {
  try {
    await ensureElectronBinary();
  } catch (error) {
    console.error(
      `[electron:dev] Failed to repair Electron binary: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

try {
  rmSync(viteDevUrlPath, { force: true });
  rmSync(readyFilePath, { force: true });
} catch {
  // Best-effort stale startup marker cleanup before this run rewrites them.
}

const writePidFile = () => {
  writeFileSync(
    pidFilePath,
    JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
};

const removeOwnPidFile = () => {
  try {
    const raw = readFileSync(pidFilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.pid !== process.pid) {
      return;
    }
    rmSync(pidFilePath, { force: true });
  } catch {
    // Ignore stale or missing pid files during shutdown.
  }
};

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(pid, signal) {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall through to direct pid signal.
    }
  }
  return signalPid(pid, signal);
}

async function stopOrphanedDevChildren() {
  if (process.platform === "win32") {
    let output = "";
    try {
      // PowerShell string literal escape: single-quote → doubled.
      const escapedNeedles = managedCommandNeedles.map((needle) =>
        needle.replace(/'/g, "''"),
      );
      // Push needle filtering INTO WMI via a server-side -Filter (CommandLine
      // LIKE '%needle%' OR …) so PowerShell does not stream every process's
      // full command line back — the slowest part of the prior ForEach-Object
      // scan. The WQL pattern is intentionally left permissive: any LIKE
      // metacharacters in a path ('%', '_', '[') stay as wildcards, so the
      // filter can only over-match, never drop a real orphan. The unchanged
      // client-side Contains() pass below restores the exact original
      // substring-match semantics, so the same needles and kill behavior hold.
      // (Same coarse-prefilter + precise-Contains idiom as findPreviewProcessIds
      // in desktop/electron/bootstrap/office-preview-bridge.ts.)
      const filterClause = escapedNeedles
        .map((needle) => `CommandLine LIKE '%${needle}%'`)
        .join(" OR ");
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$needles = @(${escapedNeedles.map((needle) => `'${needle}'`).join(",")})`,
        "$currentPid = $PID",
        "$matches = @()",
        `Get-CimInstance Win32_Process -Filter "${filterClause}" | ForEach-Object {`,
        "  $line = [string]$_.CommandLine",
        "  if ($line -and [int]$_.ProcessId -ne $currentPid) {",
        "    foreach ($needle in $needles) {",
        "      if ($line.Contains($needle)) { $matches += [int]$_.ProcessId; break }",
        "    }",
        "  }",
        "}",
        "$matches | Sort-Object -Unique | ConvertTo-Json -Compress",
      ].join("; ");
      output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
    } catch {
      return;
    }

    const raw = output.trim();
    if (!raw) {
      return;
    }

    let parsed = [];
    try {
      const value = JSON.parse(raw);
      parsed = Array.isArray(value) ? value : [value];
    } catch {
      parsed = raw.split(/\s+/);
    }

    const pids = parsed
      .map((value) => Number.parseInt(String(value), 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);

    if (pids.length > 0) {
      // Batch every orphan into a single taskkill invocation (taskkill
      // accepts repeated `/pid` pairs) so we pay one CreateProcess instead
      // of one per orphan on the Windows startup path.
      const killArgs = pids.flatMap((pid) => ["/pid", String(pid)]);
      killArgs.push("/T", "/F");
      try {
        execFileSync("taskkill", killArgs, {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        for (const pid of pids) {
          signalPid(pid, "SIGTERM");
        }
      }
    }
    return;
  }

  let output = "";
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return;
  }

  const pids = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const ppid = Number.parseInt(match[2] ?? "", 10);
    const command = match[3] ?? "";
    if (
      Number.isFinite(pid) &&
      pid !== process.pid &&
      ppid === 1 &&
      managedCommandNeedles.some((needle) => command.includes(needle))
    ) {
      pids.push(pid);
    }
  }

  for (const pid of pids) {
    signalProcessGroup(pid, "SIGTERM");
  }
  if (pids.length === 0) {
    return;
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  for (const pid of pids) {
    signalProcessGroup(pid, "SIGKILL");
  }
}

// Only sweep for orphaned dev children when a prior runner pid file is
// present — that indicates the previous run did not shut down cleanly
// (clean exits remove it via removeOwnPidFile). On a first-ever launch or a
// clean restart there is nothing to reap, so we skip the scan entirely; on
// Windows that scan is a PowerShell cold start + full WMI/CIM Win32_Process
// enumeration that would otherwise be paid on every `electron:dev` launch.
if (existsSync(pidFilePath)) {
  await stopOrphanedDevChildren();
}
writePidFile();

// The Electron child reads these from its inherited env: the ready file is
// how electron-main signals first paint back to the launcher, keyed by this
// supervisor's pid.
process.env.STELLA_ELECTRON_DEV_RUNNER_PID = String(process.pid);
process.env.STELLA_ELECTRON_READY_FILE = readyFilePath;

function log(message) {
  console.log(`[electron:dev] ${message}`);
}

function logError(message) {
  console.error(`[electron:dev] ${message}`);
}

let shuttingDown = false;
let exitCode = 0;
let viteServer = null;
let bundleSourceWatcher = null;
let electronLifecycle = null;

async function shutdownAll(trigger) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (trigger) {
    log(trigger);
  }

  await Promise.all([
    electronLifecycle?.stop().catch(() => undefined),
    bundleSourceWatcher?.close().catch(() => undefined),
    viteServer?.close().catch(() => undefined),
  ]);

  removeOwnPidFile();
  process.exit(exitCode);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    exitCode = 0;
    void shutdownAll(`received ${signal}`);
  });
}

process.on("uncaughtException", (error) => {
  exitCode = 1;
  console.error(error);
  void shutdownAll("uncaught exception");
});

process.on("unhandledRejection", (reason) => {
  exitCode = 1;
  console.error(reason);
  void shutdownAll("unhandled rejection");
});

process.on("exit", () => {
  removeOwnPidFile();
});

// Self-mod HMR endpoints are gated by Vite's localhost binding plus an
// `Origin == null` check on the request -- not by a shared token. See
// `isAuthorizedSelfModRequest` in `desktop/vite/self-mod-hmr-plugin.ts` for the
// gate and `runtime/kernel/self-mod/hmr.ts` for the worker-side caller.
const startVite = async () => {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: viteConfigPath,
    root: desktopDir,
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address && typeof address === "object") {
    log(`vite listening on ${address.address}:${address.port}`);
  }
  return server;
};

try {
  const [server] = await Promise.all([
    startVite(),
    ensureElectronBundlesFresh({ log }),
  ]);
  viteServer = server;
} catch (error) {
  exitCode = 1;
  logError(
    `startup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  await shutdownAll("startup failure");
}

if (!shuttingDown) {
  bundleSourceWatcher = watchElectronBundleSources({ log, logError });
  electronLifecycle = startElectronLifecycle({
    readiness: Promise.resolve(),
    electronEnv: {
      // Electron's main process gets its own V8 bytecode cache, separate from
      // this supervisor's, so the two don't churn one shared dir.
      NODE_COMPILE_CACHE: v8CompileCacheDir,
    },
    onExit: (code) => {
      exitCode = code;
      void shutdownAll(
        code === 0
          ? "electron exited; stopping electron dev."
          : `electron exited with code ${code}; stopping electron dev.`,
      );
    },
  });
}
