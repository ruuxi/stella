import { hashStellaAppDir, resolveLogDir } from "../worker/runtime-paths.js";

/**
 * Resolution of the local, machine-only diagnostics log directory.
 *
 * Keyed on the same per-stellaAppDir hash the runtime worker uses so that
 * multiple Stella installs on one machine (dev tree at `~/projects/stella`
 * plus a launcher install at `~/Stella`) keep separate logs and never
 * interleave their diagnostics. Colocated with the worker's raw
 * `runtime.log` (see `resolveLogDir` in runtime-paths.ts).
 *
 * Layout:
 *   ~/.stella/logs/<rootHash>/
 *     ├── runtime.log              <- worker stdout/stderr (rotating)
 *     ├── error-YYYY-MM-DD.txt     <- crashes, uncaught errors (daily)
 *     └── process-YYYY-MM-DD.txt   <- worker / native lifecycle (daily)
 *
 * The entire `~/.stella` tree is outside any git checkout, so these files
 * are never committed. Logs are local-only and never uploaded anywhere.
 */

export type LogPaths = {
  rootHash: string;
  logDir: string;
};

export const resolveLogPaths = (
  stellaAppDir: string,
  options?: { homeDir?: string },
): LogPaths => ({
  rootHash: hashStellaAppDir(stellaAppDir),
  logDir: resolveLogDir(stellaAppDir, options),
});
