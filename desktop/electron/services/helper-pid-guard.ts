import { execFileSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";

const TERM_GRACE_MS = 150;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read a pidfile and return a valid positive pid, or null if absent/garbage. */
export const readPidFile = (filePath: string): number | null => {
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return null;
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

/** Liveness probe. Treats an unsignalable (EPERM) process as alive. */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Exists but unsignalable → treat as alive so we still attempt SIGTERM.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Confirm that a persisted pid actually still belongs to one of our native
 * helper daemons before we signal it.
 *
 * Why: detached helper daemons (chronicle, meeting_capture, ...) write a
 * pidfile so an orphan left behind by an unclean quit can be reaped on the next
 * launch. But pids are RECYCLED by the OS — across sessions a stale pidfile can
 * point at a completely unrelated process the kernel handed the same pid to.
 * A bare `process.kill(pid, 0)` liveness check passes for that unrelated
 * process, so SIGTERM/SIGKILL would take down something random.
 *
 * This verifies the live process still looks like the expected helper.
 * macOS/Linux match the full command line via `ps` (binary path plus
 * `expectedCommandFragments`). Windows matches only the image name via
 * `tasklist` — the command line would need a WMI query costing hundreds of ms
 * on the quit path, and a pid recycled to an unrelated process won't share the
 * helper's image name, which is all this guard exists to rule out. It returns
 * `false` whenever it cannot POSITIVELY confirm a match (process gone, tool
 * failed, mismatch) — callers MUST NOT kill on a `false` result.
 */
export const pidMatchesHelperBinary = (
  pid: number,
  helperBinaryPath: string,
  expectedCommandFragments: readonly string[] = [],
): boolean => {
  if (!Number.isFinite(pid) || pid <= 0 || !helperBinaryPath) {
    return false;
  }
  const baseName = path.basename(helperBinaryPath);
  if (!baseName) {
    return false;
  }
  // The image-name stem without extension, for a tolerant Windows comparison.
  const stem = baseName.replace(/\.[^.]+$/, "");
  const requiredFragments = expectedCommandFragments.filter(Boolean);

  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "tasklist.exe",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", windowsHide: true, timeout: 2000 },
      );
      // Matching row: "image_name","pid",... — a non-matching filter prints an
      // INFO: message instead of a CSV row.
      const row = output
        .split(/\r?\n/)
        .find((line) => line.startsWith('"'));
      const imageName = row ? /^"([^"]*)"/.exec(row)?.[1] : undefined;
      if (!imageName) {
        return false;
      }
      const imageStem = imageName.replace(/\.[^.]+$/, "");
      return imageStem.toLowerCase() === stem.toLowerCase();
    }

    // macOS / Linux: `ps -p <pid> -o command=` prints the full command line, or
    // nothing (and exits non-zero → throws) when the pid is gone.
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 4000,
    });
    const command = output.trim();
    if (!command) {
      return false;
    }
    return (
      command.includes(helperBinaryPath) &&
      requiredFragments.every((fragment) => command.includes(fragment))
    );
  } catch {
    // Tool failed or the pid no longer exists — cannot confirm identity.
    return false;
  }
};

/**
 * Fallback teardown for a detached native helper daemon. If the primary
 * socket stop didn't take the process down, SIGTERM the persisted pid, wait a
 * grace period, then SIGKILL — but only after {@link pidMatchesHelperBinary}
 * confirms the live pid is actually our helper (guarding against OS pid reuse).
 * The pidfile is always removed afterwards so the next launch never reaps a
 * recycled pid.
 */
export async function reapPidfileDaemon(
  pidFile: string,
  helperBinaryPath: string | null,
  expectedCommandFragments: readonly string[],
): Promise<void> {
  const pid = readPidFile(pidFile);
  if (
    pid !== null &&
    isProcessAlive(pid) &&
    helperBinaryPath !== null &&
    pidMatchesHelperBinary(pid, helperBinaryPath, expectedCommandFragments)
  ) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    await sleep(TERM_GRACE_MS);
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  try {
    await fs.rm(pidFile, { force: true });
  } catch {
    // ignored — stale pidfile is harmless (next teardown re-checks liveness)
  }
}
