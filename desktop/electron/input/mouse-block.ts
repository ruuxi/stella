/**
 * Spawns the platform-native `mouse_block` helper that intercepts and drops
 * Cmd/Ctrl + RightClick at the OS level so the foreground app's context menu
 * never appears.
 *
 *   macOS  → Swift CGEventTap (mouse_block)
 *   win32  → C++ WH_MOUSE_LL hook  (mouse_block.exe)
 *   linux  → not supported (pure-uIOhook fallback in MouseHookManager)
 *
 * Communication is line-based stdout: `READY`, `DOWN <x> <y>`, `UP <x> <y>`,
 * `EXIT`. Coordinates are native screen pixels.
 */

import { execFile, spawn, type ChildProcess } from "child_process";
import { resolveNativeHelperPath } from "../native-helper-path.js";

export type MouseBlockEvent = "down" | "up";
export type MouseBlockCallback = (
  event: MouseBlockEvent,
  x: number,
  y: number,
) => void;

let helperProcess: ChildProcess | null = null;
let currentCallback: MouseBlockCallback | null = null;
let isReady = false;

const signalPid = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

const killHelperPids = async (pids: number[]) => {
  if (pids.length === 0) {
    return;
  }

  for (const pid of pids) {
    signalPid(pid, "SIGTERM");
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 150));

  for (const pid of pids) {
    signalPid(pid, "SIGKILL");
  }
};

const findStaleHelperPids = async (helperPath: string): Promise<number[]> => {
  if (process.platform === "win32") {
    return [];
  }

  const currentPid = process.pid;
  return await new Promise((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,command="],
      { maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }

        const pids: number[] = [];
        for (const line of stdout.split("\n")) {
          const match = line.match(/^\s*(\d+)\s+(.+)$/);
          if (!match) continue;
          const pid = Number.parseInt(match[1] ?? "", 10);
          const command = match[2] ?? "";
          if (
            Number.isFinite(pid) &&
            pid !== currentPid &&
            (command === helperPath || command.startsWith(`${helperPath} `))
          ) {
            pids.push(pid);
          }
        }
        resolve(pids);
      },
    );
  });
};

const findHelperPath = (): string | null => {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return null;
  }
  return resolveNativeHelperPath("mouse_block");
};

/** True if a native mouse_block helper exists for the current platform. */
export const isNativeBlockingAvailable = (): boolean => {
  return findHelperPath() !== null;
};

/**
 * Start the mouse blocking helper. Returns true if the helper was spawned.
 * The first `READY` line on stdout flips the manager into a ready state.
 */
export const startMouseBlock = (callback: MouseBlockCallback): boolean => {
  if (helperProcess) {
    return isReady;
  }

  const helperPath = findHelperPath();
  if (!helperPath) {
    return false;
  }

  currentCallback = callback;

  try {
    helperProcess = spawn(helperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    helperProcess.stdout?.setEncoding("utf8");
    helperProcess.stderr?.setEncoding("utf8");

    helperProcess.stdout?.on("data", (data: string) => {
      const lines = data.split("\n");
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const parts = line.split(/\s+/);
        const cmd = parts[0];

        if (cmd === "READY") {
          isReady = true;
        } else if (cmd === "DOWN" && parts.length >= 3) {
          const x = parseInt(parts[1] ?? "", 10);
          const y = parseInt(parts[2] ?? "", 10);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            currentCallback?.("down", x, y);
          }
        } else if (cmd === "UP" && parts.length >= 3) {
          const x = parseInt(parts[1] ?? "", 10);
          const y = parseInt(parts[2] ?? "", 10);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            currentCallback?.("up", x, y);
          }
        } else if (cmd === "EXIT") {
          // Helper announced clean exit; the 'exit' handler will null out
          // helperProcess.
        }
      }
    });

    helperProcess.stderr?.on("data", (data: string) => {
      // Surface helper errors so missing-permission failures are diagnosable
      // in the dev console without spamming users.
      if (process.env.STELLA_DEBUG_MOUSE_BLOCK) {
        console.warn("[mouse-block] stderr:", data.trim());
      }
    });

    helperProcess.on("exit", () => {
      helperProcess = null;
      isReady = false;
    });

    helperProcess.on("error", (error) => {
      console.warn("[mouse-block] helper failed to start:", error.message);
      helperProcess = null;
      isReady = false;
    });

    return true;
  } catch (error) {
    console.warn("[mouse-block] spawn threw:", (error as Error).message);
    helperProcess = null;
    isReady = false;
    return false;
  }
};

/** Terminate the helper process. */
export const stopMouseBlock = (): boolean => {
  if (!helperProcess) {
    return true;
  }
  try {
    helperProcess.kill("SIGTERM");
    helperProcess = null;
    isReady = false;
    currentCallback = null;
    return true;
  } catch {
    return false;
  }
};

/** Terminate any native mouse_block helpers launched from this Stella install. */
export const stopAllMouseBlockHelpers = async (): Promise<void> => {
  stopMouseBlock();

  const helperPath = findHelperPath();
  if (!helperPath) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/IM", "mouse_block.exe", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }

  const stalePids = await findStaleHelperPids(helperPath);
  await killHelperPids(stalePids);
};
