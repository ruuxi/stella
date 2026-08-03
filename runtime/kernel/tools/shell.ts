/**
 * Shell tools: platform shell plus `exec_command` / `write_stdin` handlers.
 */

import { spawn } from "child_process";
import path from "path";
import os from "os";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { readdir, stat } from "fs/promises";
import {
  fileChange,
  isNoiseProducedPath,
  MAX_PRODUCED_FILES_PER_COMMAND,
  type FileChangeRecord,
  type ProducedFileRecord,
} from "../../contracts/file-changes.js";
import type {
  ToolContext,
  ToolResult,
  ShellRecord,
  ToolUpdateCallback,
} from "./types.js";
import { truncate } from "./utils.js";
import {
  HeadTailOutputBuffer,
  RAW_SHELL_OUTPUT_MAX_BYTES,
} from "./head-tail-output-buffer.js";
import { resolveBundledRuntimeFile } from "../shared/runtime-paths.js";
import { isDangerousCommand } from "./command-safety.js";
import { getInstallUpdateCommandDenialReason } from "./install-update-allowlist.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import { getStellaComputerSessionId } from "./stella-computer-session.js";
import { inferShellMentionedPaths } from "./path-inference.js";
import { isKnownSafeCommand } from "./safe-commands.js";
import { sanitizeToolVisibleText } from "./safety.js";
import type { OfficePreviewRef } from "../../contracts/office-preview.js";
import {
  purgeExpiredDeferredDeletes,
  trashPathsForDeferredDelete,
} from "./deferred-delete.js";
import { extractNativeWindowsDeleteTargets } from "./deferred-delete-cli.js";

export type ShellState = {
  shells: Map<string, ManagedShellRecord>;
  secretStateRoot: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaComputerCliPath?: string;
  stellaConnectCliPath?: string;
  stellaMediaCliPath?: string;
  stellaXApiCliPath?: string;
  nodeShimDir?: string;
  windowsCliShimDir?: string;
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  /**
   * Per-root CLI bridge UDS path (worker-side). Forwarded into the PTY
   * env as `STELLA_CLI_BRIDGE_SOCK` so sidecar CLIs (`stella-connect`)
   * can call back into the host for credential dialogs. The CLI gates
   * on the env var existing; absent ⇒ legacy exit-2 `auth_required`.
   */
  cliBridgeSocketPath?: string;
  lastDeferredDeleteSweepAt: number;
};

type ShellStateOptions = {
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaComputerCliPath?: string;
  stellaConnectCliPath?: string;
  stellaMediaCliPath?: string;
  stellaXApiCliPath?: string;
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  cliBridgeSocketPath?: string;
};

const WINDOWS_CLI_SHIMS = [
  {
    command: "stella-office",
    optionKey: "stellaOfficeBinPath",
    envVar: "STELLA_OFFICE_BIN",
  },
  {
    command: "stella-computer",
    optionKey: "stellaComputerCliPath",
    envVar: "STELLA_COMPUTER_CLI",
  },
  {
    command: "stella-connect",
    optionKey: "stellaConnectCliPath",
    envVar: "STELLA_CONNECT_CLI",
  },
  {
    command: "stella-media",
    optionKey: "stellaMediaCliPath",
    envVar: "STELLA_MEDIA_CLI",
  },
  {
    command: "stella-x-api",
    optionKey: "stellaXApiCliPath",
    envVar: "STELLA_X_API_CLI",
  },
] as const;

/**
 * Which thread started a shell session. Sessions outlive the run that
 * created them and live in one worker-wide map, so the record has to carry
 * its own provenance — that's what lets a background command's exit be
 * delivered back to the agent that started it.
 */
export type ShellSessionOwner = {
  conversationId: string;
  /** Durable agent thread id. Absent for non-subagent callers. */
  agentId?: string;
  agentType?: string;
};

/** What a caller learns when a background session finally exits. */
export type ShellExitSnapshot = {
  sessionId: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  startedAt: number;
  completedAt: number;
  /** Captured output, raw-capped with equal head and tail retention. */
  output: string;
  owner?: ShellSessionOwner;
};

type ManagedShellRecord = ShellRecord & {
  unreadOutput: string;
  outputBuffer: HeadTailOutputBuffer;
  unreadOutputBuffer: HeadTailOutputBuffer;
  outputVersion: number;
  waiters: Set<() => void>;
  /**
   * Persistent exit listeners, distinct from `waiters`: those are one-shot
   * and fire on any activity, these fire once when the process is gone.
   */
  exitWatchers: Set<() => void>;
  child?: SpawnedShell;
  stdinOpen: boolean;
  owner?: ShellSessionOwner;
  startSnapshot?: FileSnapshot | null;
  externalCandidateSnapshots?: ExternalCandidateSnapshot[];
  producedFilesReported?: boolean;
};

type FileSnapshotEntry = {
  size: number;
  mtimeMs: number;
};

type FileSnapshot = {
  root: string;
  files: Map<string, FileSnapshotEntry>;
  complete: boolean;
};

type ExternalCandidateSnapshot =
  | {
      path: string;
      kind: "missing";
    }
  | {
      path: string;
      kind: "file";
      entry: FileSnapshotEntry;
    }
  | {
      path: string;
      kind: "directory";
      snapshot: FileSnapshot | null;
    };

// Stella defaults: 10s for exec_command, 250ms for write_stdin. Letting
// short commands finish on the first call dramatically reduces the
// "got a session_id, must call write_stdin to drain" round-trip the model
// would otherwise need for every fast shell invocation.
export const DEFAULT_EXEC_YIELD_MS = 10_000;
export const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const MAX_EXEC_YIELD_MS = 30_000;
// An empty `write_stdin` is a poll, not an interaction: nobody is waiting on
// the other side of the pipe, so it can afford to block much longer than a
// write. Codex sizes the same case at 5s..5min; matching that lets an agent
// sit out a quiet build inside its turn instead of round-tripping every 30s.
export const DEFAULT_EMPTY_POLL_YIELD_MS = 5_000;
const MAX_EMPTY_POLL_YIELD_MS = 5 * 60_000;
export const DEFAULT_EXEC_OUTPUT_TOKENS = 10_000;
const MAX_SNAPSHOT_FILES = 20_000;
const SNAPSHOT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  "target",
  "dist",
  "build",
  "coverage",
  ".cache",
  "electron-user-data",
  // Electron build output (`desktop/dist-electron`) — segment-exact matching
  // means the plain "dist" entry above doesn't cover it. Dev-instance builds
  // copy the whole runtime-extension tree (agents/skills manifests) in here,
  // which showed up in production as phantom "update" produced files.
  "dist-electron",
]);

const APPROX_BYTES_PER_TOKEN = 4;
/**
 * Cheap byte-count → token estimate. Off by a small constant from any real
 * tokenizer, but stable enough for "did this output get truncated".
 */
export const approxTokenCount = (text: string): number =>
  Math.ceil(text.length / APPROX_BYTES_PER_TOKEN);

const OFFICE_PREVIEW_REF_MARKER = "__STELLA_OFFICE_PREVIEW_REF__";
const DEFERRED_DELETE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const normalizeSnapshotRoot = (cwd: string): string | null => {
  const resolved = path.resolve(cwd);
  try {
    if (!existsSync(resolved)) return null;
  } catch {
    return null;
  }
  return resolved;
};

const shouldSkipSnapshotDir = (relativeDir: string): boolean => {
  const normalized = relativeDir.split(path.sep).join("/");
  return (
    SNAPSHOT_IGNORED_DIRS.has(normalized) ||
    normalized.split("/").some((segment) => SNAPSHOT_IGNORED_DIRS.has(segment))
  );
};

const snapshotFiles = async (cwd: string): Promise<FileSnapshot | null> => {
  const root = normalizeSnapshotRoot(cwd);
  if (!root) return null;

  const files = new Map<string, FileSnapshotEntry>();
  let complete = true;

  const walk = async (dir: string): Promise<void> => {
    if (!complete) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!complete) return;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        if (!shouldSkipSnapshotDir(relativePath)) {
          await walk(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.size >= MAX_SNAPSHOT_FILES) {
        complete = false;
        return;
      }
      try {
        const info = await stat(fullPath);
        files.set(fullPath, {
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // File changed while walking; the next snapshot will catch stable state.
      }
    }
  };

  await walk(root);
  return { root, files, complete };
};

const resolveShellSnapshotRoot = (
  cwd: string,
  context?: ToolContext,
): string => {
  const resolvedCwd = normalizeSnapshotRoot(cwd);
  const resolvedStellaAppDir = context?.stellaAppDir?.trim()
    ? normalizeSnapshotRoot(context.stellaAppDir)
    : null;
  if (
    resolvedCwd &&
    resolvedStellaAppDir &&
    (resolvedCwd === resolvedStellaAppDir ||
      resolvedCwd.startsWith(`${resolvedStellaAppDir}${path.sep}`))
  ) {
    return resolvedStellaAppDir;
  }
  return resolvedCwd ?? cwd;
};

const isSameOrInsidePath = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const isBroadExternalCandidate = (candidate: string): boolean => {
  const resolved = path.resolve(candidate);
  return (
    resolved === path.parse(resolved).root ||
    resolved === os.homedir() ||
    resolved === path.dirname(os.homedir())
  );
};

const diffFileSnapshots = (
  before: FileSnapshot | null,
  after: FileSnapshot | null,
): FileChangeRecord[] | undefined => {
  if (
    !before ||
    !after ||
    !before.complete ||
    !after.complete ||
    before.root !== after.root
  ) {
    return undefined;
  }
  const changes: FileChangeRecord[] = [];
  for (const [filePath, afterEntry] of after.files) {
    const beforeEntry = before.files.get(filePath);
    if (!beforeEntry) {
      changes.push(fileChange(filePath, { type: "add" }));
      continue;
    }
    if (
      beforeEntry.size !== afterEntry.size ||
      beforeEntry.mtimeMs !== afterEntry.mtimeMs
    ) {
      changes.push(fileChange(filePath, { type: "update" }));
    }
  }
  for (const filePath of before.files.keys()) {
    if (!after.files.has(filePath)) {
      changes.push(fileChange(filePath, { type: "delete" }));
    }
  }
  return changes.length > 0 ? changes : undefined;
};

const snapshotExternalCandidate = async (
  candidatePath: string,
): Promise<ExternalCandidateSnapshot> => {
  try {
    const info = await stat(candidatePath);
    if (info.isDirectory()) {
      return {
        path: candidatePath,
        kind: "directory",
        snapshot: await snapshotFiles(candidatePath),
      };
    }
    if (info.isFile()) {
      return {
        path: candidatePath,
        kind: "file",
        entry: {
          size: info.size,
          mtimeMs: info.mtimeMs,
        },
      };
    }
  } catch {
    // Missing or unreadable paths are still useful: if they appear after the
    // command, we can report them as produced files.
  }
  return { path: candidatePath, kind: "missing" };
};

const snapshotExternalCandidates = async (
  candidatePaths: string[],
  snapshotRoot: string,
): Promise<ExternalCandidateSnapshot[] | undefined> => {
  const root = path.resolve(snapshotRoot);
  const paths = [
    ...new Set(candidatePaths.map((candidate) => path.resolve(candidate))),
  ].filter(
    (candidate) =>
      !isSameOrInsidePath(candidate, root) &&
      !isBroadExternalCandidate(candidate),
  );
  if (paths.length === 0) return undefined;
  return Promise.all(
    paths.map((candidate) => snapshotExternalCandidate(candidate)),
  );
};

const diffExternalCandidateSnapshots = async (
  beforeSnapshots: ExternalCandidateSnapshot[] | undefined,
): Promise<ProducedFileRecord[] | undefined> => {
  if (!beforeSnapshots || beforeSnapshots.length === 0) return undefined;
  const changes: ProducedFileRecord[] = [];

  for (const before of beforeSnapshots) {
    const after = await snapshotExternalCandidate(before.path);
    if (after.kind === "missing") {
      if (before.kind !== "missing") {
        changes.push(fileChange(before.path, { type: "delete" }));
      }
      continue;
    }

    if (after.kind === "file") {
      if (before.kind !== "file") {
        changes.push(fileChange(after.path, { type: "add" }));
        continue;
      }
      if (
        before.entry.size !== after.entry.size ||
        before.entry.mtimeMs !== after.entry.mtimeMs
      ) {
        changes.push(fileChange(after.path, { type: "update" }));
      }
      continue;
    }

    if (before.kind === "directory") {
      changes.push(
        ...(diffFileSnapshots(before.snapshot, after.snapshot) ?? []),
      );
      continue;
    }
    if (after.snapshot?.complete) {
      for (const filePath of after.snapshot.files.keys()) {
        changes.push(fileChange(filePath, { type: "add" }));
      }
    }
  }

  return changes.length > 0 ? changes : undefined;
};

/**
 * Merge + sanitize snapshot-detected produced files. Every shell
 * `producedFiles` emission (foreground exec, background completion via
 * `takeCompletedProducedFiles`, `write_stdin` / shell-status drains) funnels
 * through here, so collection semantics live in one place:
 *
 *  1. Dedupe across the root-workspace diff and external-candidate diffs.
 *  2. Drop noise paths (`isNoiseProducedPath`: hidden/profile/cache dirs,
 *     logs, locks) so they never persist into `tool_result` payloads.
 *  3. Bulk-churn guard: if a single command still "produced" more than
 *     `MAX_PRODUCED_FILES_PER_COMMAND` files, the diff is environment churn
 *     (spawned app bootstrap seeding its data dir, git checkout/worktree
 *     mtime rewrites, dependency installs) — not deliverables. Drop the
 *     whole batch; deliberate writes still surface via explicit
 *     `fileChanges` from Write/Edit/apply_patch, which never pass through
 *     snapshot detection.
 */
const mergeProducedFiles = (
  ...groups: Array<ProducedFileRecord[] | undefined>
): ProducedFileRecord[] | undefined => {
  const out: ProducedFileRecord[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!group) continue;
    for (const file of group) {
      if (isNoiseProducedPath(file.path)) continue;
      const key = `${file.kind.type}:${file.path}:${file.kind.type === "update" ? (file.kind.move_path ?? "") : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
  }
  if (out.length > MAX_PRODUCED_FILES_PER_COMMAND) return undefined;
  return out.length > 0 ? out : undefined;
};

const snapshotShellSideEffects = async (
  args: Record<string, unknown>,
  snapshotRoot: string,
  context?: ToolContext,
): Promise<{
  rootSnapshot: FileSnapshot | null;
  externalCandidateSnapshots?: ExternalCandidateSnapshot[];
}> => {
  const rootSnapshot = await snapshotFiles(snapshotRoot);
  const externalCandidateSnapshots = await snapshotExternalCandidates(
    inferShellMentionedPaths(args, context),
    snapshotRoot,
  );
  return { rootSnapshot, externalCandidateSnapshots };
};

const shouldSnapshotShellSideEffects = (command: string): boolean =>
  !isKnownSafeCommand(command);

const takeCompletedProducedFiles = async (
  record: ManagedShellRecord,
): Promise<ProducedFileRecord[] | undefined> => {
  if (record.running || record.producedFilesReported) return undefined;
  record.producedFilesReported = true;
  const produced = mergeProducedFiles(
    diffFileSnapshots(
      record.startSnapshot ?? null,
      await snapshotFiles(record.startSnapshot?.root ?? record.cwd),
    ),
    await diffExternalCandidateSnapshots(record.externalCandidateSnapshots),
  );
  // The shell is terminated and its produced files are now reported, so the
  // snapshot data (a FileSnapshot Map of up to MAX_SNAPSHOT_FILES entries plus
  // the external-candidate snapshots) and the child-process handle are fully
  // consumed. Release them so completed records stop pinning that memory for
  // the rest of the session. The record itself stays in state.shells so
  // status/read paths keep working off the (capped) output buffers.
  record.startSnapshot = null;
  record.externalCandidateSnapshots = undefined;
  record.child = undefined;
  return produced;
};

/**
 * Drain completed-but-unreported produced files from managed shell sessions.
 *
 * Long-running/background commands that finish AFTER the model's last poll
 * leave their deliverables sitting on the record with `producedFilesReported`
 * still false — the foreground `write_stdin` / shell-status drain never runs
 * for them, so those files (e.g. a video render written after the tool
 * nominally completed) would only ride individual `tool_result` entries and
 * never reach the agent-completed rollup. This lets the agent finalizer pull
 * such late deliverables in before the rollup emits.
 *
 * Scope with `sessionIds` to the sessions a run actually touched (omit to
 * sweep every session). Delegates to `takeCompletedProducedFiles`, so the
 * one-shot `producedFilesReported` flag, `isNoiseProducedPath` guards,
 * per-command dedup, and the `MAX_PRODUCED_FILES_PER_COMMAND` cap all still
 * apply, and a session already drained inline yields nothing here.
 */
export const drainCompletedProducedFiles = async (
  state: ShellState,
  sessionIds?: Iterable<string>,
): Promise<ProducedFileRecord[]> => {
  const records = sessionIds
    ? [...new Set(sessionIds)]
        .map((id) => state.shells.get(id))
        .filter((record): record is ManagedShellRecord => Boolean(record))
    : [...state.shells.values()];
  const drained: ProducedFileRecord[] = [];
  for (const record of records) {
    const produced = await takeCompletedProducedFiles(record);
    if (produced) drained.push(...produced);
  }
  return drained;
};

export const extractOfficePreviewRef = (
  output: string,
): { cleanedOutput: string; officePreviewRef?: OfficePreviewRef } => {
  let officePreviewRef: OfficePreviewRef | undefined;
  const keptLines: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(OFFICE_PREVIEW_REF_MARKER)) {
      keptLines.push(line);
      continue;
    }

    const rawPayload = line.slice(OFFICE_PREVIEW_REF_MARKER.length).trim();
    if (!rawPayload) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawPayload) as OfficePreviewRef;
      if (
        typeof parsed.sessionId === "string" &&
        typeof parsed.title === "string" &&
        typeof parsed.sourcePath === "string"
      ) {
        officePreviewRef = parsed;
      }
    } catch {
      keptLines.push(line);
    }
  }

  const cleanedOutput = keptLines.join("\n").trim();
  return {
    cleanedOutput:
      cleanedOutput ||
      (officePreviewRef ? "Started inline office preview." : ""),
    ...(officePreviewRef ? { officePreviewRef } : {}),
  };
};

const buildWindowsCliShimScript = (envVar: string): string =>
  [
    "@echo off",
    'if "%STELLA_NODE_IS_ELECTRON%"=="1" set "ELECTRON_RUN_AS_NODE=1"',
    `"%STELLA_NODE_BIN%" "%${envVar}%" %*`,
    "",
  ].join("\r\n");

const buildWindowsNodeShimScript = (): string =>
  [
    "@echo off",
    'if "%STELLA_NODE_IS_ELECTRON%"=="1" set "ELECTRON_RUN_AS_NODE=1"',
    '"%STELLA_NODE_BIN%" %*',
    "",
  ].join("\r\n");

const buildUnixNodeShimScript = (): string =>
  [
    "#!/bin/sh",
    'if [ "${STELLA_NODE_IS_ELECTRON:-0}" = "1" ]; then',
    '  ELECTRON_RUN_AS_NODE=1 exec "$STELLA_NODE_BIN" "$@"',
    "fi",
    'exec "$STELLA_NODE_BIN" "$@"',
    "",
  ].join("\n");

const ensureNodeShim = (secretStateRoot: string): string | undefined => {
  const shimDir = path.join(secretStateRoot, "shell-shims");
  const shimPath = path.join(
    shimDir,
    process.platform === "win32" ? "node.cmd" : "node",
  );
  try {
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      shimPath,
      process.platform === "win32"
        ? buildWindowsNodeShimScript()
        : buildUnixNodeShimScript(),
      "utf-8",
    );
    if (process.platform !== "win32") chmodSync(shimPath, 0o700);
    return shimDir;
  } catch {
    return undefined;
  }
};

const ensureWindowsCliShims = (
  secretStateRoot: string,
  options?: ShellStateOptions,
): string | undefined => {
  const requested = WINDOWS_CLI_SHIMS.filter(
    (shim) => typeof options?.[shim.optionKey] === "string",
  );
  if (requested.length === 0) {
    return undefined;
  }

  const shimDir = path.join(secretStateRoot, "shell-shims");
  try {
    mkdirSync(shimDir, { recursive: true });
    for (const shim of requested) {
      writeFileSync(
        path.join(shimDir, `${shim.command}.cmd`),
        buildWindowsCliShimScript(shim.envVar),
        "utf-8",
      );
    }
    return shimDir;
  } catch {
    return undefined;
  }
};

export function createShellState(
  secretStateRoot: string,
  options?: ShellStateOptions,
): ShellState {
  if (!secretStateRoot.trim()) {
    throw new Error("createShellState requires a secretStateRoot.");
  }

  const nodeShimDir = ensureNodeShim(secretStateRoot);
  const windowsCliShimDir =
    process.platform === "win32"
      ? ensureWindowsCliShims(secretStateRoot, options)
      : undefined;

  return {
    shells: new Map(),
    secretStateRoot,
    stellaBrowserBinPath: options?.stellaBrowserBinPath,
    stellaOfficeBinPath: options?.stellaOfficeBinPath,
    stellaComputerCliPath: options?.stellaComputerCliPath,
    stellaConnectCliPath: options?.stellaConnectCliPath,
    stellaMediaCliPath: options?.stellaMediaCliPath,
    stellaXApiCliPath: options?.stellaXApiCliPath,
    ...(nodeShimDir ? { nodeShimDir } : {}),
    getStellaSiteAuth: options?.getStellaSiteAuth,
    ...(windowsCliShimDir ? { windowsCliShimDir } : {}),
    cliBridgeSocketPath: options?.cliBridgeSocketPath,
    lastDeferredDeleteSweepAt: 0,
  };
}

const deferredDeleteHelperPath = (() => {
  const resolved = resolveBundledRuntimeFile(
    "kernel/tools/deferred-delete-cli.js",
  );
  return existsSync(resolved) ? resolved : "";
})();

const rewriteDeleteBypassPatterns = (command: string) =>
  command
    .replace(/\bcommand\s+(rm|rmdir|unlink)\b/g, "$1")
    .replace(/\b(?:\/usr\/bin|\/bin)\/(rm|rmdir|unlink)\b/g, "$1")
    .replace(/(^|[\s;&|()])\\(rm|rmdir|unlink)\b/g, "$1$2");

const buildProtectedCommand = (
  command: string,
  options?: {
    stellaBrowserBinPath?: string;
    stellaOfficeBinPath?: string;
    stellaComputerCliPath?: string;
    stellaConnectCliPath?: string;
    stellaMediaCliPath?: string;
    stellaXApiCliPath?: string;
  },
) => {
  if (!deferredDeleteHelperPath) {
    return command;
  }
  const stellaOfficeBin =
    options?.stellaOfficeBinPath && existsSync(options.stellaOfficeBinPath)
      ? options.stellaOfficeBinPath
      : "";
  const stellaComputerCli =
    options?.stellaComputerCliPath && existsSync(options.stellaComputerCliPath)
      ? options.stellaComputerCliPath
      : "";
  const stellaConnectCli =
    options?.stellaConnectCliPath && existsSync(options.stellaConnectCliPath)
      ? options.stellaConnectCliPath
      : "";
  const stellaMediaCli =
    options?.stellaMediaCliPath && existsSync(options.stellaMediaCliPath)
      ? options.stellaMediaCliPath
      : "";
  const stellaXApiCli =
    options?.stellaXApiCliPath && existsSync(options.stellaXApiCliPath)
      ? options.stellaXApiCliPath
      : "";

  // Dynamically detect python-like invocations (python, python3, python3.11, py, etc.)
  const pythonPattern = /\b(python\d*(?:\.\d+)?|py)\b/g;
  const pythonNames = new Set<string>();
  let m;
  while ((m = pythonPattern.exec(command)) !== null) {
    pythonNames.add(m[1]);
  }

  const pythonFuncs = [...pythonNames]
    .map(
      (name) =>
        `${name}() { __stella_dd python "$PWD" "$(type -P ${name} || true)" "$@"; }`,
    )
    .join("\n");
  const pythonExports =
    pythonNames.size > 0 ? ` ${[...pythonNames].join(" ")}` : "";

  const preamble = `
__stella_node_exec() {
  if [ "$STELLA_NODE_IS_ELECTRON" = "1" ]; then
    ELECTRON_RUN_AS_NODE=1 "$STELLA_NODE_BIN" "$@"
  else
    "$STELLA_NODE_BIN" "$@"
  fi
}
__stella_dd() {
  __stella_node_exec "$STELLA_DEFERRED_DELETE_HELPER" "$@"
}
__stella_git_exec() {
  if [ -n "$STELLA_GIT_BIN" ]; then
    "$STELLA_GIT_BIN" "$@"
  else
    command git "$@"
  fi
}
__stella_git_stage_feature_dependencies() {
  local repo_root
  repo_root="$(__stella_git_exec rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$repo_root" ]; then
    return 0
  fi
  local dep_files=(
    "$repo_root/package.json"
    "$repo_root/bun.lock"
    "$repo_root/bun.lockb"
    "$repo_root/package-lock.json"
    "$repo_root/pnpm-lock.yaml"
    "$repo_root/yarn.lock"
    "$repo_root/npm-shrinkwrap.json"
  )
  local existing_files=()
  for dep_file in "\${dep_files[@]}"; do
    if [ -f "$dep_file" ]; then
      existing_files+=("$dep_file")
    fi
  done
  if [ "\${#existing_files[@]}" -gt 0 ]; then
    __stella_git_exec add -- "\${existing_files[@]}" >/dev/null 2>&1 || true
  fi
}
git() {
  if [ "$1" = "commit" ]; then
    local has_feature_tag=0
    for arg in "$@"; do
      case "$arg" in
        *"[feature:"*)
          has_feature_tag=1
          ;;
      esac
    done
    if [ "$has_feature_tag" -eq 1 ]; then
      __stella_git_stage_feature_dependencies
    fi
  fi
  __stella_git_exec "$@"
}
rm() { __stella_dd delete "$PWD" rm "$@"; }
rmdir() { __stella_dd delete "$PWD" rmdir "$@"; }
unlink() { __stella_dd delete "$PWD" unlink "$@"; }
del() { rm "$@"; }
erase() { rm "$@"; }
rd() { rmdir "$@"; }
powershell() { __stella_dd powershell "$PWD" "$(type -P powershell || true)" "$@"; }
pwsh() { __stella_dd powershell "$PWD" "$(type -P pwsh || true)" "$@"; }
${stellaOfficeBin ? `stella-office() { __stella_node_exec "$STELLA_OFFICE_BIN" "$@"; }` : ""}
${stellaComputerCli ? `stella-computer() { __stella_node_exec "$STELLA_COMPUTER_CLI" "$@"; }` : ""}
${stellaConnectCli ? `stella-connect() { __stella_node_exec "$STELLA_CONNECT_CLI" "$@"; }` : ""}
${stellaMediaCli ? `stella-media() { __stella_node_exec "$STELLA_MEDIA_CLI" "$@"; }` : ""}
${stellaXApiCli ? `stella-x-api() { __stella_node_exec "$STELLA_X_API_CLI" "$@"; }` : ""}
${pythonFuncs}
export -f __stella_node_exec __stella_dd __stella_git_exec __stella_git_stage_feature_dependencies git rm rmdir unlink del erase rd powershell pwsh${stellaOfficeBin ? " stella-office" : ""}${stellaComputerCli ? " stella-computer" : ""}${stellaConnectCli ? " stella-connect" : ""}${stellaMediaCli ? " stella-media" : ""}${stellaXApiCli ? " stella-x-api" : ""}${pythonExports} >/dev/null 2>&1 || true
`;

  return `${preamble}\n${rewriteDeleteBypassPatterns(command)}`;
};

const buildShellCommand = (command: string, state: ShellState): string => {
  if (process.platform === "win32") {
    return command;
  }
  return buildProtectedCommand(command, state);
};

const resolveStellaDataDirFromState = (
  state: ShellState,
): string | undefined => {
  const stateRoot = path.resolve(state.secretStateRoot);
  if (path.basename(stateRoot) === "state") {
    return path.dirname(stateRoot);
  }
  return stateRoot;
};

const maybeSweepDeferredDeletes = (state: ShellState) => {
  const now = Date.now();
  if (
    state.lastDeferredDeleteSweepAt > 0 &&
    now - state.lastDeferredDeleteSweepAt < DEFERRED_DELETE_SWEEP_INTERVAL_MS
  ) {
    return;
  }
  state.lastDeferredDeleteSweepAt = now;
  void purgeExpiredDeferredDeletes({
    stellaDataDir: resolveStellaDataDirFromState(state),
    now,
  }).catch(() => undefined);
};

const maybeTrashNativeWindowsDeletes = async (
  state: ShellState,
  command: string,
  cwd: string,
  context?: ToolContext,
): Promise<ToolResult | null> => {
  if (process.platform !== "win32") {
    return null;
  }

  const targets = extractNativeWindowsDeleteTargets(command);
  if (targets.length === 0) {
    return null;
  }

  const trashResult = await trashPathsForDeferredDelete(targets, {
    cwd,
    force: /(?:^|\s)(?:\/q|\/f|-force)\b/i.test(command),
    source: "shell:windows-native",
    stellaDataDir: resolveStellaDataDirFromState(state),
    requestId: context?.requestId,
    agentType: context?.agentType,
    conversationId: context?.conversationId,
  });

  const lines: string[] = [];
  if (trashResult.trashed.length > 0) {
    lines.push(
      `Moved ${trashResult.trashed.length} item(s) to Stella trash (auto-delete in 24h).`,
    );
  }
  for (const skipped of trashResult.skipped) {
    lines.push(`Skipped missing path: ${skipped}`);
  }
  for (const error of trashResult.errors) {
    lines.push(`Cannot remove '${error.path}': ${error.error}`);
  }

  return {
    ...(trashResult.errors.length > 0
      ? { error: lines.join("\n") || "Delete command blocked." }
      : { result: lines.join("\n") || "Delete command completed." }),
  };
};

export const resolveShellNodeBinary = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const explicit = env.STELLA_NODE_BIN?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  // The detached Stella runtime itself runs under Bun. Electron's host
  // executable is passed into that worker specifically so child processes can
  // launch its bundled Node runtime with ELECTRON_RUN_AS_NODE=1.
  const hostExecutable = env.STELLA_HOST_EXECUTABLE_PATH?.trim();
  if (hostExecutable && existsSync(hostExecutable)) return hostExecutable;

  // Tests and non-Electron embeddings commonly run the kernel under Node.
  return process.execPath;
};

export const shellNodeUsesElectron = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (env.STELLA_NODE_IS_ELECTRON?.trim() === "1") return true;
  const explicit = env.STELLA_NODE_BIN?.trim();
  if (explicit && existsSync(explicit)) return false;
  const hostExecutable = env.STELLA_HOST_EXECUTABLE_PATH?.trim();
  return Boolean(hostExecutable && existsSync(hostExecutable));
};

const buildShellEnv = (
  envOverrides?: Record<string, string>,
  options?: {
    secretStateRoot?: string;
    stellaBrowserBinPath?: string;
    stellaOfficeBinPath?: string;
    stellaComputerCliPath?: string;
    stellaConnectCliPath?: string;
    stellaMediaCliPath?: string;
    stellaXApiCliPath?: string;
    nodeShimDir?: string;
    windowsCliShimDir?: string;
    cliBridgeSocketPath?: string;
  },
) => {
  const mergedEnv: NodeJS.ProcessEnv = {
    ...(envOverrides ? { ...process.env, ...envOverrides } : process.env),
    STELLA_NODE_BIN: resolveShellNodeBinary(
      envOverrides ? { ...process.env, ...envOverrides } : process.env,
    ),
    STELLA_NODE_IS_ELECTRON: shellNodeUsesElectron(
      envOverrides ? { ...process.env, ...envOverrides } : process.env,
    )
      ? "1"
      : "0",
    STELLA_RUNTIME_WORKER_PID: String(process.pid),
    STELLA_DEFERRED_DELETE_HELPER: deferredDeleteHelperPath,
    ...(options?.secretStateRoot
      ? { STELLA_DATA_DIR: options.secretStateRoot }
      : {}),
    ...(options?.stellaOfficeBinPath
      ? { STELLA_OFFICE_BIN: options.stellaOfficeBinPath }
      : {}),
    ...(options?.stellaComputerCliPath
      ? { STELLA_COMPUTER_CLI: options.stellaComputerCliPath }
      : {}),
    ...(options?.stellaConnectCliPath
      ? { STELLA_CONNECT_CLI: options.stellaConnectCliPath }
      : {}),
    ...(options?.stellaMediaCliPath
      ? { STELLA_MEDIA_CLI: options.stellaMediaCliPath }
      : {}),
    ...(options?.stellaXApiCliPath
      ? { STELLA_X_API_CLI: options.stellaXApiCliPath }
      : {}),
    ...(options?.cliBridgeSocketPath
      ? { STELLA_CLI_BRIDGE_SOCK: options.cliBridgeSocketPath }
      : {}),
  };
  // Connector actions authenticate through the worker broker. Never inherit
  // raw Stella bearer variables into shell or agent processes.
  delete mergedEnv.STELLA_SITE_AUTH_TOKEN;
  delete mergedEnv.STELLA_LLM_PROXY_TOKEN;
  delete mergedEnv.STELLA_AUTH_TOKEN;

  const shellShimDirs = [options?.nodeShimDir, options?.windowsCliShimDir]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  if (shellShimDirs.length > 0) {
    const pathKey =
      Object.keys(mergedEnv).find((key) => key.toLowerCase() === "path") ??
      "PATH";
    const existingPath =
      typeof mergedEnv[pathKey] === "string" ? mergedEnv[pathKey] : "";
    mergedEnv[pathKey] = [...shellShimDirs, existingPath]
      .filter(Boolean)
      .join(path.delimiter);
    if (options?.nodeShimDir) {
      mergedEnv.STELLA_NODE_SHIM_DIR = options.nodeShimDir;
    }
    if (options?.windowsCliShimDir) {
      mergedEnv.STELLA_WINDOWS_CLI_SHIM_DIR = options.windowsCliShimDir;
    }
  }

  return mergedEnv;
};

// macOS ships /bin/bash on every install. Linux's FHS guarantees /bin/bash
// for any system that has bash at all. Some Stella launch contexts (notably
// the Electron app launched via Finder/Dock with a stripped GUI environment)
// hand the runtime a `process.env` whose PATH does not include /bin, so
// spawning bare "bash" fails with `ENOENT: posix_spawn 'bash'`. Probe for
// /bin/bash first; fall back to PATH-resolved "bash" only if it isn't there
// (e.g. a stripped-down BSD jail), which keeps test environments working.
const UNIX_BASH_CANDIDATES = [
  "/bin/bash",
  "/usr/bin/bash",
  "/usr/local/bin/bash",
];

const resolveUnixBash = (): string => {
  for (const candidate of UNIX_BASH_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "bash";
};

const resolveShellLaunch = (
  command: string,
): { shell: string; args: string[] } | { error: string } => {
  if (process.platform !== "win32") {
    return { shell: resolveUnixBash(), args: ["-lc", command] };
  }

  return {
    shell: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", command],
  };
};

type SpawnedShell = ReturnType<typeof spawn>;

export const resolveExecOutputTokens = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : DEFAULT_EXEC_OUTPUT_TOKENS;

type DrainedOutput = {
  text: string;
  originalLength: number;
  truncated: boolean;
};

const drainUnreadOutput = (record: ManagedShellRecord): DrainedOutput => {
  const unread = record.unreadOutputBuffer.drain();
  record.unreadOutput = "";
  return {
    text: unread.text,
    originalLength: unread.totalBytes,
    truncated: unread.omittedBytes > 0,
  };
};

const refreshShellOutputText = (record: ManagedShellRecord): void => {
  record.output = record.outputBuffer.snapshot().text;
  record.unreadOutput = record.unreadOutputBuffer.snapshot().text;
};

const appendShellOutput = (record: ManagedShellRecord, text: string): void => {
  record.outputBuffer.pushText(text);
  record.unreadOutputBuffer.pushText(text);
  refreshShellOutputText(record);
};

const notifyShellActivity = (record: ManagedShellRecord) => {
  record.outputVersion += 1;
  const waiters = [...record.waiters];
  record.waiters.clear();
  for (const waiter of waiters) {
    waiter();
  }
};

const notifyShellExit = (record: ManagedShellRecord) => {
  const watchers = [...record.exitWatchers];
  record.exitWatchers.clear();
  for (const watcher of watchers) {
    try {
      watcher();
    } catch {
      // A listener must never break the process teardown path.
    }
  }
};

export const readShellExitSnapshot = (
  state: ShellState,
  sessionId: string,
): ShellExitSnapshot | null => {
  const record = state.shells.get(sessionId);
  if (!record || record.running) return null;
  return {
    sessionId: record.id,
    command: record.command,
    cwd: record.cwd,
    exitCode: record.exitCode,
    startedAt: record.startedAt,
    completedAt: record.completedAt ?? Date.now(),
    output: sanitizeToolVisibleText(record.output),
    ...(record.owner ? { owner: record.owner } : {}),
  };
};

/**
 * Call `listener` once the session's process is gone, and return a
 * disposer. Sessions that already exited resolve on the next microtask so
 * callers never have to special-case the race between "still running when
 * I checked" and "exited before I subscribed".
 */
export const watchShellExit = (
  state: ShellState,
  sessionId: string,
  listener: () => void,
): (() => void) => {
  const record = state.shells.get(sessionId);
  if (!record) return () => {};
  if (!record.running) {
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) listener();
    });
    return () => {
      disposed = true;
    };
  }
  record.exitWatchers.add(listener);
  return () => {
    record.exitWatchers.delete(listener);
  };
};

/**
 * Every running session an agent thread owns, whichever of its runs started
 * them. Scoping a thread's background work by owner rather than by "what
 * the last run touched" is what keeps a job started three turns ago — and
 * not polled since — from being forgotten.
 */
export const listRunningShellSessionsOwnedBy = (
  state: ShellState,
  agentId: string,
): string[] => {
  const owned: string[] = [];
  for (const shell of state.shells.values()) {
    if (!shell.running || shell.owner?.agentId !== agentId) continue;
    owned.push(shell.id);
  }
  return owned;
};

/** Stamp the calling thread onto a freshly started session. */
export const setShellOwner = (
  record: Pick<ShellRecord, "id">,
  context?: ToolContext,
): void => {
  if (!context?.conversationId) return;
  (record as ManagedShellRecord).owner = {
    conversationId: context.conversationId,
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.agentType ? { agentType: context.agentType } : {}),
  };
};

const waitForShellActivity = async (
  record: ManagedShellRecord,
  observedVersion: number,
  timeoutMs: number,
  signal?: AbortSignal,
) => {
  if (!record.running || record.outputVersion !== observedVersion) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      record.waiters.delete(finish);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(finish, timeoutMs);
    record.waiters.add(finish);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
};

const settleCompletedShell = async (
  record: ManagedShellRecord,
  signal?: AbortSignal,
) => {
  const deadline = Date.now() + 250;
  while (record.running && Date.now() < deadline) {
    const observedVersion = record.outputVersion;
    try {
      await waitForShellActivity(
        record,
        observedVersion,
        Math.min(25, Math.max(1, deadline - Date.now())),
        signal,
      );
    } catch {
      return;
    }
  }
};

const spawnShellProcess = (
  shell: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) =>
  spawn(shell, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // On Unix, make the shell the leader of its own process group so timeouts
    // and manual kills can terminate the entire command tree.
    detached: process.platform !== "win32",
  });

const killShellProcess = (
  child: SpawnedShell,
  signal: NodeJS.Signals = "SIGTERM",
) => {
  const pid = child.pid;

  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    const taskkillArgs = ["/pid", String(pid), "/t"];
    if (signal === "SIGKILL") {
      taskkillArgs.push("/f");
    }

    const killer = spawn("taskkill", taskkillArgs, {
      stdio: "ignore",
      windowsHide: true,
    });

    killer.on("error", () => {
      try {
        child.kill(signal);
      } catch {
        // Ignore cleanup errors on fallback kill.
      }
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Ignore cleanup errors when the child already exited.
    }
  }
};

const terminateShellProcess = (child: SpawnedShell) => {
  if (child.exitCode !== null) {
    return;
  }

  killShellProcess(child, "SIGTERM");

  const forceKillTimer = setTimeout(() => {
    if (child.exitCode !== null) {
      return;
    }
    killShellProcess(child, "SIGKILL");
  }, 1_000);
  forceKillTimer.unref?.();
};

const shouldUseStellaComputer = (command: string): boolean =>
  /\bstella-computer\b/.test(command);

const shouldUseStellaMedia = (command: string): boolean =>
  /\bstella-media\b/.test(command);

const shouldUseStellaXApi = (command: string): boolean =>
  /\bstella-x-api\b/.test(command);

export const startShell = (
  state: ShellState,
  command: string,
  cwd: string,
  envOverrides?: Record<string, string>,
  onClose?: () => void,
  startSnapshot?: FileSnapshot | null,
  externalCandidateSnapshots?: ExternalCandidateSnapshot[],
  onActivity?: (record: ManagedShellRecord) => void,
) => {
  maybeSweepDeferredDeletes(state);
  const id = crypto.randomUUID();
  const shellCommand = buildShellCommand(command, state);
  const launch = resolveShellLaunch(shellCommand);

  if ("error" in launch) {
    const safeLaunchError = sanitizeToolVisibleText(launch.error);
    const record: ManagedShellRecord = {
      id,
      command,
      cwd,
      output: safeLaunchError,
      outputBuffer: new HeadTailOutputBuffer(RAW_SHELL_OUTPUT_MAX_BYTES),
      running: false,
      exitCode: 127,
      startedAt: Date.now(),
      completedAt: Date.now(),
      unreadOutput: safeLaunchError,
      unreadOutputBuffer: new HeadTailOutputBuffer(RAW_SHELL_OUTPUT_MAX_BYTES),
      outputVersion: 1,
      waiters: new Set(),
      exitWatchers: new Set(),
      stdinOpen: false,
      startSnapshot,
      externalCandidateSnapshots,
      kill: () => {},
    };
    record.outputBuffer.pushText(safeLaunchError);
    record.unreadOutputBuffer.pushText(safeLaunchError);
    state.shells.set(id, record);
    return record;
  }

  const child = spawnShellProcess(
    launch.shell,
    launch.args,
    cwd,
    buildShellEnv(envOverrides, state),
  );

  const record: ManagedShellRecord = {
    id,
    command,
    cwd,
    output: "",
    outputBuffer: new HeadTailOutputBuffer(RAW_SHELL_OUTPUT_MAX_BYTES),
    running: true,
    exitCode: null,
    startedAt: Date.now(),
    completedAt: null,
    child,
    unreadOutput: "",
    unreadOutputBuffer: new HeadTailOutputBuffer(RAW_SHELL_OUTPUT_MAX_BYTES),
    outputVersion: 0,
    waiters: new Set(),
    exitWatchers: new Set(),
    stdinOpen: Boolean(child.stdin),
    startSnapshot,
    externalCandidateSnapshots,
    kill: () => {
      terminateShellProcess(child);
    },
  };

  const append = (data: Buffer) => {
    const chunk = data.toString();
    const safeChunk = sanitizeToolVisibleText(chunk);
    appendShellOutput(record, safeChunk);
    notifyShellActivity(record);
    onActivity?.(record);
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.stdin?.on("close", () => {
    record.stdinOpen = false;
    notifyShellActivity(record);
  });
  child.on("error", (error) => {
    const safeMessage = sanitizeToolVisibleText(error.message);
    appendShellOutput(record, safeMessage);
    record.running = false;
    record.exitCode = record.exitCode ?? 1;
    record.completedAt = Date.now();
    record.stdinOpen = false;
    notifyShellActivity(record);
    notifyShellExit(record);
    onActivity?.(record);
    if (onClose) {
      onClose();
    }
  });
  child.on("close", (code) => {
    record.running = false;
    record.exitCode = code ?? null;
    record.completedAt = Date.now();
    record.stdinOpen = false;
    notifyShellActivity(record);
    notifyShellExit(record);
    onActivity?.(record);
    if (onClose) {
      onClose();
    }
  });

  state.shells.set(id, record);
  return record;
};

export const runShell = async (
  state: ShellState,
  command: string,
  cwd: string,
  timeoutMs: number,
  envOverrides?: Record<string, string>,
) => {
  maybeSweepDeferredDeletes(state);
  const shellCommand = buildShellCommand(command, state);
  const launch = resolveShellLaunch(shellCommand);

  if ("error" in launch) {
    return launch.error;
  }

  return new Promise<string>((resolve) => {
    const child = spawnShellProcess(
      launch.shell,
      launch.args,
      cwd,
      buildShellEnv(envOverrides, state),
    );

    let output = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      terminateShellProcess(child);
      resolve(`Command timed out after ${timeoutMs}ms.\n\n${truncate(output)}`);
    }, timeoutMs);

    const append = (data: Buffer) => {
      output = truncate(`${output}${data.toString()}`);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Clean Windows console noise (chcp output) that confuses LLMs
      const cleanedOutput = sanitizeToolVisibleText(output)
        .replace(/^Active code page: \d+\s*/gm, "")
        .replace(/^\s+/, ""); // Trim leading whitespace after removal
      if (code === 0) {
        resolve(cleanedOutput || "Command completed successfully (no output).");
      } else {
        resolve(
          `Command exited with code ${code}.\n\n${truncate(cleanedOutput)}`,
        );
      }
    });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(`Failed to execute command: ${error.message}`);
    });
  });
};

const resolveManagedShellCommand = (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
): {
  command: string;
  cwd: string;
  envOverrides: Record<string, string>;
} => {
  let command = String(args.cmd ?? args.command ?? "");
  const cwd = String(
    args.workdir ??
      args.working_directory ??
      context?.stellaAppDir ??
      process.cwd(),
  );
  const envOverrides: Record<string, string> = {};
  const stellaComputerSessionId = getStellaComputerSessionId(context);
  const localBinPaths = [
    ...(context?.stellaDataDir
      ? [path.join(path.resolve(context.stellaDataDir), "bin")]
      : []),
    path.join(path.resolve(cwd), "node_modules", ".bin"),
    ...(context?.stellaAppDir
      ? [path.join(path.resolve(context.stellaAppDir), "node_modules", ".bin")]
      : []),
  ].filter(
    (entry, index, entries) =>
      existsSync(entry) && entries.indexOf(entry) === index,
  );

  if (localBinPaths.length > 0) {
    envOverrides.PATH = [...localBinPaths, process.env.PATH ?? ""]
      .filter(Boolean)
      .join(path.delimiter);
  }

  if (shouldUseStellaComputer(command) && stellaComputerSessionId) {
    envOverrides.STELLA_COMPUTER_SESSION = stellaComputerSessionId;
  }

  if (shouldUseStellaMedia(command)) {
    const siteAuth = state.getStellaSiteAuth?.();
    if (siteAuth) {
      envOverrides.STELLA_MEDIA_BASE_URL = siteAuth.baseUrl;
      envOverrides.STELLA_MEDIA_AUTH_TOKEN = siteAuth.authToken;
    }
    if (context?.deviceId) {
      envOverrides.STELLA_DEVICE_ID = context.deviceId;
    }
  }

  if (shouldUseStellaXApi(command)) {
    const siteAuth = state.getStellaSiteAuth?.();
    if (siteAuth) {
      envOverrides.STELLA_X_API_BASE_URL = siteAuth.baseUrl;
      envOverrides.STELLA_X_API_AUTH_TOKEN = siteAuth.authToken;
    }
  }

  return { command, cwd, envOverrides };
};

const resolveExecYieldTime = (
  value: unknown,
  defaultMs: number = DEFAULT_EXEC_YIELD_MS,
  maxMs: number = MAX_EXEC_YIELD_MS,
): number => {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : defaultMs;
  return Math.max(0, Math.min(raw, maxMs));
};

const buildExecToolPayload = (
  record: ManagedShellRecord,
  drained: DrainedOutput,
  callStartedAt: number,
): Record<string, unknown> => {
  const wallTimeSeconds = (Date.now() - callStartedAt) / 1000;
  // Includes wall_time_seconds and original_token_count so the model can
  // detect output omitted by the raw one-MiB collector and react.
  const payload: Record<string, unknown> = {
    session_id: record.running ? record.id : null,
    running: record.running,
    exit_code: record.running ? null : record.exitCode,
    output: sanitizeToolVisibleText(drained.text),
    wall_time_seconds: wallTimeSeconds,
    // Always report the pre-collection-cap token estimate so callers can
    // distinguish small output from output whose middle was omitted.
    original_token_count: Math.ceil(
      drained.originalLength / APPROX_BYTES_PER_TOKEN,
    ),
    cwd: record.cwd,
    command: record.command,
  };
  return payload;
};

const writeToShellStdin = async (
  record: ManagedShellRecord,
  chars: string,
): Promise<void> => {
  if (!chars) return;
  const stdin = record.child?.stdin;
  if (!stdin || !record.stdinOpen || stdin.destroyed || !stdin.writable) {
    throw new Error(`stdin is not available for session ${record.id}.`);
  }
  await new Promise<void>((resolve, reject) => {
    stdin.write(chars, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
};

export const handleExecCommand = async (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
  signal?: AbortSignal,
  onUpdate?: ToolUpdateCallback,
): Promise<ToolResult> => {
  const callStartedAt = Date.now();
  const prepared = resolveManagedShellCommand(state, args, context);
  const dangerReason = isDangerousCommand(prepared.command);
  if (dangerReason) {
    return {
      error: `Command blocked: this operation is potentially destructive and has been denied for safety. (${dangerReason})`,
    };
  }
  if (context?.agentType === AGENT_IDS.INSTALL_UPDATE) {
    const denial = getInstallUpdateCommandDenialReason(prepared.command);
    if (denial) {
      return { error: `Command blocked: ${denial}` };
    }
  }
  if (!prepared.command.trim()) {
    return { error: "cmd is required." };
  }

  const windowsDeleteResult = await maybeTrashNativeWindowsDeletes(
    state,
    prepared.command,
    prepared.cwd,
    context,
  );
  if (windowsDeleteResult) {
    return windowsDeleteResult;
  }

  const beforeSideEffects = shouldSnapshotShellSideEffects(prepared.command)
    ? await snapshotShellSideEffects(
        { cmd: prepared.command, workdir: prepared.cwd },
        resolveShellSnapshotRoot(prepared.cwd, context),
        context,
      )
    : { rootSnapshot: null };
  let lastUpdateAt = 0;
  const modelOutputTokens = resolveExecOutputTokens(args.max_output_tokens);
  const emitUpdate = (record: ManagedShellRecord) => {
    if (!onUpdate) return;
    const now = Date.now();
    if (record.running && now - lastUpdateAt < 250) return;
    lastUpdateAt = now;
    const unread = record.unreadOutputBuffer.snapshot();
    const drained = {
      text: unread.text,
      originalLength: unread.totalBytes,
      truncated: unread.omittedBytes > 0,
    };
    const payload = buildExecToolPayload(record, drained, callStartedAt);
    onUpdate({ result: payload, details: payload });
  };
  const record = startShell(
    state,
    prepared.command,
    prepared.cwd,
    prepared.envOverrides,
    undefined,
    beforeSideEffects.rootSnapshot,
    beforeSideEffects.externalCandidateSnapshots,
    emitUpdate,
  );
  setShellOwner(record, context);
  const observedVersion = record.outputVersion;
  try {
    await waitForShellActivity(
      record,
      observedVersion,
      resolveExecYieldTime(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS),
      signal,
    );
  } catch (error) {
    // Ownership classification (run-owned vs conversation-scoped): this
    // call STARTED the shell and is aborting before the session id ever
    // reaches the model — nothing can address the shell later, so it is
    // run-owned and would otherwise orphan until toolHost shutdown. Kill
    // it through the TERM→1s→KILL ladder as the aborted call's finalizer.
    // Session shells whose id was already delivered (later write_stdin
    // polls) are conversation-scoped and deliberately exempt: aborting a
    // poll never kills the shell.
    if (record.running) {
      try {
        record.kill();
      } catch {
        // Best effort; the process may already be exiting.
      }
    }
    return { error: (error as Error).message };
  }
  await settleCompletedShell(record, signal);

  const drained = drainUnreadOutput(record);
  const payload = buildExecToolPayload(record, drained, callStartedAt);
  const producedFiles = !record.running
    ? await takeCompletedProducedFiles(record)
    : undefined;
  return {
    result: payload,
    details: payload,
    modelOutputTokens,
    ...(producedFiles ? { producedFiles } : {}),
  };
};

export const handleWriteStdin = async (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> => {
  const callStartedAt = Date.now();
  const sessionId = String(args.session_id ?? "").trim();
  if (!sessionId) {
    return { error: "session_id is required." };
  }
  const record = state.shells.get(sessionId);
  if (!record) {
    return { error: `Session not found: ${sessionId}` };
  }

  const chars = typeof args.chars === "string" ? args.chars : "";
  if (context?.agentType === AGENT_IDS.INSTALL_UPDATE && chars.length > 0) {
    return {
      error:
        "Command blocked: install_update may only poll running sessions with empty write_stdin input.",
    };
  }
  const observedVersion = record.outputVersion;
  try {
    await writeToShellStdin(record, chars);
  } catch (error) {
    if (record.running) {
      return { error: (error as Error).message };
    }
  }

  try {
    await waitForShellActivity(
      record,
      observedVersion,
      chars
        ? resolveExecYieldTime(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS)
        : // An empty write is a pure poll on a silent process, so it gets a
          // far higher ceiling than an interactive write — matching Codex,
          // whose background-terminal poll budget is 5 minutes. The wait
          // still returns the instant the process emits anything or exits,
          // so a chatty build is unaffected; this only stops a quiet
          // 10-minute job from costing twenty round-trips.
          resolveExecYieldTime(
            args.yield_time_ms,
            DEFAULT_EMPTY_POLL_YIELD_MS,
            MAX_EMPTY_POLL_YIELD_MS,
          ),
      signal,
    );
  } catch (error) {
    return { error: (error as Error).message };
  }
  await settleCompletedShell(record, signal);

  const drained = drainUnreadOutput(record);
  const payload = buildExecToolPayload(record, drained, callStartedAt);
  const producedFiles = await takeCompletedProducedFiles(record);
  return {
    result: payload,
    details: payload,
    modelOutputTokens: resolveExecOutputTokens(args.max_output_tokens),
    ...(producedFiles ? { producedFiles } : {}),
  };
};

export const handleBash = async (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
  _signal?: AbortSignal,
): Promise<ToolResult> => {
  const prepared = resolveManagedShellCommand(state, args, context);
  let command = prepared.command;

  // Safety check: reject dangerous commands
  const dangerReason = isDangerousCommand(command);
  if (dangerReason) {
    return {
      error: `Command blocked: this operation is potentially destructive and has been denied for safety. (${dangerReason})`,
    };
  }
  if (context?.agentType === AGENT_IDS.INSTALL_UPDATE) {
    const denial = getInstallUpdateCommandDenialReason(command);
    if (denial) {
      return { error: `Command blocked: ${denial}` };
    }
  }

  const timeout = Math.min(Number(args.timeout ?? 120_000), 600_000);
  const cwd = prepared.cwd;
  const runInBackground = Boolean(args.run_in_background ?? false);
  const envOverrides = prepared.envOverrides;

  const windowsDeleteResult = await maybeTrashNativeWindowsDeletes(
    state,
    command,
    cwd,
    context,
  );
  if (windowsDeleteResult) {
    return windowsDeleteResult;
  }

  if (runInBackground) {
    const beforeSideEffects = shouldSnapshotShellSideEffects(command)
      ? await snapshotShellSideEffects(
          { cmd: command, workdir: cwd },
          resolveShellSnapshotRoot(cwd, context),
          context,
        )
      : { rootSnapshot: null };
    const record = startShell(
      state,
      command,
      cwd,
      envOverrides,
      undefined,
      beforeSideEffects.rootSnapshot,
      beforeSideEffects.externalCandidateSnapshots,
    );
    setShellOwner(record, context);
    const extracted = extractOfficePreviewRef(record.output || "");
    return {
      result: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(
        extracted.cleanedOutput || "(no output yet)",
      )}`,
      ...(extracted.officePreviewRef
        ? {
            details: {
              text: `Command running in background.\nShell ID: ${record.id}\n\n${truncate(
                extracted.cleanedOutput || "(no output yet)",
              )}`,
              officePreviewRef: extracted.officePreviewRef,
            },
          }
        : {}),
    };
  }

  const shouldSnapshotSideEffects = shouldSnapshotShellSideEffects(command);
  const snapshotRoot = shouldSnapshotSideEffects
    ? resolveShellSnapshotRoot(cwd, context)
    : null;
  const beforeSideEffects =
    shouldSnapshotSideEffects && snapshotRoot
      ? await snapshotShellSideEffects(
          { cmd: command, workdir: cwd },
          snapshotRoot,
          context,
        )
      : { rootSnapshot: null };
  const output = await runShell(state, command, cwd, timeout, envOverrides);
  const producedFiles =
    shouldSnapshotSideEffects && snapshotRoot
      ? mergeProducedFiles(
          diffFileSnapshots(
            beforeSideEffects.rootSnapshot,
            await snapshotFiles(snapshotRoot),
          ),
          await diffExternalCandidateSnapshots(
            beforeSideEffects.externalCandidateSnapshots,
          ),
        )
      : undefined;
  const extracted = extractOfficePreviewRef(sanitizeToolVisibleText(output));
  return {
    result: truncate(extracted.cleanedOutput),
    ...(producedFiles ? { producedFiles } : {}),
    ...(extracted.officePreviewRef
      ? {
          details: {
            text: truncate(extracted.cleanedOutput),
            officePreviewRef: extracted.officePreviewRef,
          },
        }
      : {}),
  };
};

export const handleShellStatus = async (
  state: ShellState,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const shellId = String(args.shell_id ?? "");

  // If no shell_id provided, list all active shells
  if (!shellId) {
    const shells = [...state.shells.entries()].map(([id, r]) => ({
      id,
      command: r.command.slice(0, 100),
      running: r.running,
      exitCode: r.exitCode,
      elapsed: r.running
        ? `${Math.round((Date.now() - r.startedAt) / 1000)}s`
        : undefined,
    }));
    if (shells.length === 0) return { result: "No active shells." };
    return { result: JSON.stringify(shells, null, 2) };
  }

  const record = state.shells.get(shellId);
  if (!record) return { error: `Shell not found: ${shellId}` };

  const tail_lines = Number(args.tail_lines ?? 50);
  const output = sanitizeToolVisibleText(record.output || "(no output yet)");
  // Get last N lines
  const lines = output.split("\n");
  const tail = truncate(lines.slice(-tail_lines).join("\n"));

  const status = record.running ? "running" : "completed";
  const elapsed = Math.round(
    ((record.completedAt ?? Date.now()) - record.startedAt) / 1000,
  );

  let result = `Shell ${shellId}: ${status}`;
  if (!record.running) result += ` (exit code: ${record.exitCode ?? "?"})`;
  result += ` | elapsed: ${elapsed}s`;
  result += `\nCommand: ${record.command.slice(0, 200)}`;
  result += `\n\n--- Output (last ${Math.min(tail_lines, lines.length)} lines) ---\n${tail}`;

  const producedFiles = await takeCompletedProducedFiles(record);
  return {
    result,
    ...(producedFiles ? { producedFiles } : {}),
  };
};

export const handleKillShell = async (
  state: ShellState,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const shellId = String(args.shell_id ?? "");
  const record = state.shells.get(shellId);
  if (!record) {
    return { error: `Shell not found: ${shellId}` };
  }
  if (!record.running) {
    return {
      result: `Shell ${shellId} already completed.\nExit: ${record.exitCode ?? "?"}`,
    };
  }
  record.kill();
  return {
    result: `Killed shell ${shellId}.\n\nOutput:\n${truncate(
      sanitizeToolVisibleText(record.output),
    )}`,
  };
};
