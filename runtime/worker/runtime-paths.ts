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
 *     ├── runtime.sock     <- Unix domain socket the host connects to on POSIX
 *     ├── runtime.log      <- worker stdout/stderr (rotating)
 *     ├── host-executable.txt <- Electron executable path that spawned it
 *     └── root.txt         <- the literal stellaRoot, for debugging
 *
 * Windows uses named pipes instead of socket files:
 *   \\.\pipe\stella-runtime-<rootHash>
 *   \\.\pipe\stella-cli-bridge-<rootHash>
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
   * Companion local-IPC endpoint the worker listens on for sidecar CLI tools (e.g.
   * `stella-connect`) that need to call back into the host — currently
   * just to pop a credential dialog when an MCP call returns 401/403.
   * CLIs discover the path via the `STELLA_CLI_BRIDGE_SOCK` env var
   * injected by `runtime/kernel/tools/shell.ts`. Kept under the same
   * per-root namespace so multi-install machines don't collide; POSIX
   * socket files stay well under the 104-char BSD UDS path cap.
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

const windowsNamedPipePath = (name: string, rootHash: string): string =>
  `\\\\.\\pipe\\stella-${name}-${rootHash}`;

export const isWindowsNamedPipePath = (socketPath: string): boolean =>
  /^\\\\[.?]\\pipe\\/i.test(socketPath);

export const runtimeIpcPathUsesFilesystem = (socketPath: string): boolean =>
  !isWindowsNamedPipePath(socketPath);

export const runtimeIpcListenUrl = (socketPath: string): string =>
  isWindowsNamedPipePath(socketPath)
    ? `pipe://${socketPath}`
    : `unix://${socketPath}`;

export const resolveRuntimePaths = (
  stellaRoot: string,
  options?: { platform?: NodeJS.Platform; homeDir?: string },
): RuntimePaths => {
  const rootHash = hashStellaRoot(stellaRoot);
  const baseDir = path.join(
    options?.homeDir ?? os.homedir(),
    RUNTIME_DIR_NAME,
    RUNTIME_SUBDIR,
  );
  const rootDir = path.join(baseDir, rootHash);
  const platform = options?.platform ?? process.platform;
  const socketPath =
    platform === "win32"
      ? windowsNamedPipePath("runtime", rootHash)
      : path.join(rootDir, "runtime.sock");
  const cliBridgeSocketPath =
    platform === "win32"
      ? windowsNamedPipePath("cli-bridge", rootHash)
      : path.join(rootDir, "cli-bridge.sock");
  return {
    rootHash,
    rootDir,
    pidFile: path.join(rootDir, "runtime.pid"),
    lockFile: path.join(rootDir, "runtime.lock"),
    // macOS caps Unix domain socket paths at 104 chars (BSD), Linux at 108.
    // The hash + base dir keep POSIX socket files well under that.
    socketPath,
    cliBridgeSocketPath,
    logFile: path.join(rootDir, "runtime.log"),
    hostExecutableFile: path.join(rootDir, "host-executable.txt"),
    rootMarkerFile: path.join(rootDir, "root.txt"),
  };
};
