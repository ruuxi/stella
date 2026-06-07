import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const scriptDir = import.meta.dirname;
const desktopDir = resolve(scriptDir, "..");
const repoRootDir = resolve(desktopDir, "..");
const pidFilePath = resolve(desktopDir, ".electron-dev-runner.pid");
const readyFilePath = resolve(desktopDir, ".electron-dev-runner.ready");

try {
  rmSync(readyFilePath, { force: true });
} catch {
  // Best-effort stale ready marker cleanup before this run rewrites it.
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
    if (!existsSync(pidFilePath)) return;
    const parsed = JSON.parse(readFileSync(pidFilePath, "utf8"));
    if (parsed?.pid === process.pid) {
      rmSync(pidFilePath, { force: true });
    }
  } catch {
    // Best-effort cleanup only; stale pid files are cleared by the launcher.
  }
};

writePidFile();

const child = spawn(electronBinary, ["."], {
  cwd: repoRootDir,
  env: {
    ...process.env,
    STELLA_STATIC_PREVIEW: "1",
    STELLA_ELECTRON_DEV_RUNNER_PID: String(process.pid),
    STELLA_ELECTRON_READY_FILE: readyFilePath,
  },
  stdio: "inherit",
  windowsHide: true,
});

const forwardSignal = (signal) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  removeOwnPidFile();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  removeOwnPidFile();
  console.error(
    `[electron-static-preview] Failed to launch Electron: ${error.message}`,
  );
  process.exit(1);
});
