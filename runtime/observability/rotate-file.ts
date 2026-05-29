import { renameSync, statSync } from "node:fs";

const DEFAULT_RUNTIME_LOG_MAX_BYTES = 16 * 1024 * 1024;

const parsePositiveInt = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Size-based rotation for a single rolling log file (e.g. the worker's raw
 * `runtime.log` stdout/stderr sink, which is appended to across attaches and
 * would otherwise grow unbounded).
 *
 * When the file is at/over `maxBytes`, it is renamed to `<file>.1`
 * (overwriting any previous backup) so the next open starts fresh. One
 * backup is kept, bounding total usage to ~2× the cap. Best-effort: any
 * error is swallowed so logging setup never blocks process startup.
 */
export const rotateLogIfOversized = (
  filePath: string,
  maxBytes = parsePositiveInt(
    process.env.STELLA_RUNTIME_LOG_MAX_BYTES,
    DEFAULT_RUNTIME_LOG_MAX_BYTES,
  ),
): void => {
  try {
    if (statSync(filePath).size < maxBytes) return;
    renameSync(filePath, `${filePath}.1`);
  } catch {
    // File missing or not rotatable — nothing to do.
  }
};
