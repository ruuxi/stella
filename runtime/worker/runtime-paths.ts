import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * Per-stellaRoot resolution of the on-disk worker lifecycle artifacts.
 *
 * We key everything on a content-derived hash of the absolute root path
 * so that multiple Stella installs on the same machine (e.g. dev tree at
 * `~/projects/stella` plus a launcher install at `~/Stella`) don't share
 * a pidfile/socket and accidentally talk to each other's worker.
 *
 * Layout:
 *   ~/.stella/runtime/<rootHash>/
 *     ├── runtime.lock     <- flock for serializing start/stop
 *     ├── runtime.pid      <- pid of the currently-running worker
 *     ├── runtime.sock     <- Unix domain socket the host connects to
 *     ├── runtime.log      <- worker stdout/stderr (rotating)
 *     ├── host-executable.txt <- Electron executable path that spawned it
 *     └── root.txt         <- the literal stellaRoot, for debugging
 */

const RUNTIME_DIR_NAME = ".stella";
const RUNTIME_SUBDIR = "runtime";

export type RuntimePaths = {
  rootHash: string;
  rootDir: string;
  pidFile: string;
  lockFile: string;
  socketPath: string;
  /**
   * Companion UDS the worker listens on for sidecar CLI tools (e.g.
   * `stella-connect`) that need to call back into the host — currently
   * just to pop a credential dialog when an MCP call returns 401/403.
   * CLIs discover the path via the `STELLA_CLI_BRIDGE_SOCK` env var
   * injected by `runtime/kernel/tools/shell.ts`. Kept under the same
   * per-root dir so multi-install machines don't collide; both sockets
   * stay well under the 104-char BSD UDS path cap.
   */
  cliBridgeSocketPath: string;
  logFile: string;
  hostExecutableFile: string;
  rootMarkerFile: string;
};

const hashStellaRoot = (stellaRoot: string): string => {
  const normalized = path.resolve(stellaRoot);
  return crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
};

export const resolveRuntimePaths = (stellaRoot: string): RuntimePaths => {
  const rootHash = hashStellaRoot(stellaRoot);
  const baseDir = path.join(os.homedir(), RUNTIME_DIR_NAME, RUNTIME_SUBDIR);
  const rootDir = path.join(baseDir, rootHash);
  return {
    rootHash,
    rootDir,
    pidFile: path.join(rootDir, "runtime.pid"),
    lockFile: path.join(rootDir, "runtime.lock"),
    // macOS caps Unix domain socket paths at 104 chars (BSD), Linux at 108.
    // The hash + base dir keep us well under that.
    socketPath: path.join(rootDir, "runtime.sock"),
    cliBridgeSocketPath: path.join(rootDir, "cli-bridge.sock"),
    logFile: path.join(rootDir, "runtime.log"),
    hostExecutableFile: path.join(rootDir, "host-executable.txt"),
    rootMarkerFile: path.join(rootDir, "root.txt"),
  };
};
