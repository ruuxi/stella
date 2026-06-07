import { execFileSync } from "node:child_process";
import path from "node:path";

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
 * This verifies the live process's command line (macOS/Linux via `ps`) or image
 * name (Windows via `tasklist`) matches the expected helper binary. It returns
 * `false` whenever it cannot POSITIVELY confirm a match (process gone, tool
 * failed, mismatch) — callers MUST NOT kill on a `false` result. Mirrors the
 * command-line match already used in desktop-automation-cleanup.ts.
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
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 4000 },
      );
      const normalized = output.toLowerCase();
      if (!normalized) {
        return false;
      }
      return (
        normalized.includes(stem.toLowerCase()) &&
        requiredFragments.every((fragment) =>
          normalized.includes(fragment.toLowerCase()),
        )
      );
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
