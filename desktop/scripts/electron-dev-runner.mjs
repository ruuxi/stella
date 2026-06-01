import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureElectronBinary,
  isElectronBinaryHealthy,
} from "./ensure-electron-binary.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRootDir = resolve(desktopDir, "..");
const viteBinPath = resolve(
  repoRootDir,
  "node_modules",
  "vite",
  "bin",
  "vite.js",
);
const viteDevUrlPath = resolve(desktopDir, ".vite-dev-url");
const pidFilePath = resolve(desktopDir, ".electron-dev-runner.pid");
const managedScriptPaths = [
  resolve(scriptDir, "dev-electron-build.mjs"),
  resolve(scriptDir, "dev-electron.mjs"),
];
const managedCommandNeedles = [viteBinPath, ...managedScriptPaths];

if (!existsSync(viteBinPath)) {
  console.error(
    `[electron:dev] Missing Vite binary at ${viteBinPath}. Run \`bun install\` at the repo root first.`,
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
} catch {
  // Best-effort stale dev URL cleanup before Vite rewrites it for this run.
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
      const escapedNeedles = managedCommandNeedles.map((needle) =>
        needle.replace(/'/g, "''"),
      );
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$needles = @(${escapedNeedles.map((needle) => `'${needle}'`).join(",")})`,
        "$currentPid = $PID",
        "$matches = @()",
        "Get-CimInstance Win32_Process | ForEach-Object {",
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

// Self-mod HMR endpoints are gated by Vite's localhost binding plus an
// `Origin == null` check on the request -- not by a shared token. See
// `isAuthorizedSelfModRequest` in `desktop/vite.config.ts` for the gate
// and `runtime/kernel/self-mod/hmr.ts` for the worker-side caller.
const processSpecs = [
  {
    name: "vite",
    command: process.execPath,
    args: [viteBinPath],
    cwd: desktopDir,
    env: {
      ...process.env,
      NODE_ENV: "development",
    },
  },
  {
    name: "electron-build",
    command: process.execPath,
    args: [resolve(scriptDir, "dev-electron-build.mjs")],
    cwd: repoRootDir,
    env: {
      ...process.env,
      STELLA_ELECTRON_DEV_RUNNER_PID: String(process.pid),
    },
  },
  {
    name: "electron-main",
    command: process.execPath,
    args: [resolve(scriptDir, "dev-electron.mjs")],
    cwd: repoRootDir,
    env: { ...process.env },
  },
];

const activeChildren = new Map();
let shuttingDown = false;
let exitCode = 0;
const childShutdownTimeoutMs = 3_000;

function log(message) {
  console.log(`[electron:dev] ${message}`);
}

function logError(message) {
  console.error(`[electron:dev] ${message}`);
}

function waitForChildExit(child, timeoutMs = childShutdownTimeoutMs) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      resolvePromise();
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function killChildTree(child) {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise((resolvePromise) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore fallback kill errors during shutdown.
        }
        resolvePromise();
      });
      killer.on("exit", () => {
        resolvePromise();
      });
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore kill errors during shutdown.
    }
  }

  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore forced kill errors during shutdown.
      }
    }
  }, childShutdownTimeoutMs).unref();
}

async function shutdownAll(trigger) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (trigger) {
    log(trigger);
  }

  const children = [...activeChildren.values()];
  await Promise.all(
    children.map(async ({ child }) => {
      await killChildTree(child);
      await waitForChildExit(child);
    }),
  );

  removeOwnPidFile();
  process.exit(exitCode);
}

function handleRequiredFailure(spec, detail) {
  if (shuttingDown) {
    return;
  }
  exitCode = 1;
  void shutdownAll(`${spec.name} ${detail}; stopping electron dev.`);
}

function spawnProcess(spec) {
  log(`starting ${spec.name}`);
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });

  activeChildren.set(spec.name, { child, spec });

  child.on("error", (error) => {
    activeChildren.delete(spec.name);
    const detail = `failed to start: ${error instanceof Error ? error.message : String(error)}`;
    handleRequiredFailure(spec, detail);
  });

  child.on("exit", (code, signal) => {
    activeChildren.delete(spec.name);
    if (shuttingDown) {
      return;
    }

    const detail = signal
      ? `exited via ${signal}`
      : `exited with code ${code ?? 0}`;
    handleRequiredFailure(spec, detail);
  });
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

for (const spec of processSpecs) {
  spawnProcess(spec);
}
