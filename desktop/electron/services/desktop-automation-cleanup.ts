import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { resolveStatePath } from "../../../runtime/kernel/cli/shared.js";
import { resolveNativeHelperPath } from "../native-helper-path.js";

const stellaComputerStateRoot = () =>
  path.join(resolveStatePath(), "stella-computer");

const sessionsDir = (root: string) => path.join(root, "sessions");
const socketsDir = (root: string) => path.join(root, "daemon-sockets");

const readPidFile = (filePath: string): number | null => {
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      // Process exists but we can't signal it; treat as alive so we
      // still attempt SIGTERM (which may still be permitted) and let
      // the kill fail loudly if not.
      return true;
    }
    return false;
  }
};

const trySignal = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const parsePsRows = (output: string): Array<{
  pid: number;
  ppid: number;
  command: string;
}> =>
  output
    .split(/\r?\n/)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number.parseInt(match[1]!, 10),
        ppid: Number.parseInt(match[2]!, 10),
        command: match[3]!,
      };
    })
    .filter((row): row is { pid: number; ppid: number; command: string } =>
      Boolean(row && Number.isFinite(row.pid) && Number.isFinite(row.ppid)),
    );

const findOrphanedDesktopAutomationPids = (): number[] => {
  if (process.platform === "win32") return [];
  const helperPath = resolveNativeHelperPath("desktop_automation");
  if (!helperPath) return [];

  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parsePsRows(output)
      .filter(
        (row) =>
          row.pid !== process.pid &&
          row.ppid === 1 &&
          row.command.includes(helperPath) &&
          /\bdaemon\b/.test(row.command),
      )
      .map((row) => row.pid);
  } catch {
    return [];
  }
};

// Stops every long-lived `desktop_automation` daemon spawned by stella-
// computer. Each session caches a pidfile under
// `state/stella-computer/sessions/<id>/automation.pid` and a socket
// under `state/stella-computer/daemon-sockets/<sha>.sock`. We SIGTERM
// the pids, give them a moment to exit cleanly, then SIGKILL anything
// that didn't, and finally clean up the pidfile + socket so the next
// boot doesn't trip over stale entries.
//
// The reason this matters: macOS does not reload an executable under a
// running process. If you rebuild `desktop_automation` and a daemon is
// already alive, the old code stays mapped in. Killing on quit means
// the next Stella launch always spawns a fresh daemon from the
// on-disk binary.
export const stopAllDesktopAutomationDaemons = async (): Promise<void> => {
  const root = stellaComputerStateRoot();
  const sessions = sessionsDir(root);

  const targetedPids = new Set<number>(findOrphanedDesktopAutomationPids());
  const pidFiles: string[] = [];

  if (existsSync(sessions)) {
    let entries: string[];
    try {
      entries = readdirSync(sessions);
    } catch {
      entries = [];
    }

    for (const name of entries) {
      const sessionPath = path.join(sessions, name);
      let isDir = false;
      try {
        isDir = statSync(sessionPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      const pidFile = path.join(sessionPath, "automation.pid");
      const pid = readPidFile(pidFile);
      if (pid !== null && isProcessAlive(pid)) {
        targetedPids.add(pid);
      }
      if (existsSync(pidFile)) {
        pidFiles.push(pidFile);
      }
    }
  }

  for (const pid of targetedPids) {
    trySignal(pid, "SIGTERM");
  }
  if (targetedPids.size > 0) {
    await sleep(150);
    for (const pid of targetedPids) {
      if (isProcessAlive(pid)) {
        trySignal(pid, "SIGKILL");
      }
    }
  }

  // Drop the pidfiles + per-session sockets so the next launch never
  // mistakes a dead pid for a live daemon.
  for (const pidFile of pidFiles) {
    rmSync(pidFile, { force: true });
  }
  const sockets = socketsDir(root);
  if (existsSync(sockets)) {
    let socketEntries: string[];
    try {
      socketEntries = readdirSync(sockets);
    } catch {
      return;
    }
    for (const entry of socketEntries) {
      if (!entry.endsWith(".sock")) continue;
      rmSync(path.join(sockets, entry), { force: true });
    }
  }
};
