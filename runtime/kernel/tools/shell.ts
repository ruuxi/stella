/**
 * Shell tools: platform shell plus Codex-style exec_command/write_stdin handlers.
 */

import { spawn } from "child_process";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { readdir, stat } from "fs/promises";
import { setupEnvironment } from "dugite";
import {
  fileChange,
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
import { isDangerousCommand } from "./command-safety.js";
import { getInstallUpdateCommandDenialReason } from "./install-update-allowlist.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import { getStellaBrowserBridgeEnv } from "./stella-browser-bridge-config.js";
import { getStellaComputerSessionId } from "./stella-computer-session.js";
import { inferShellMentionedPaths } from "./path-inference.js";
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
  cliBridgeSocketPath?: string;
};

type ManagedShellRecord = ShellRecord & {
  unreadOutput: string;
  outputVersion: number;
  waiters: Set<() => void>;
  child?: SpawnedShell;
  stdinOpen: boolean;
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

// Codex defaults: 10s for exec_command, 250ms for write_stdin. Letting
// short commands finish on the first call dramatically reduces the
// "got a session_id, must call write_stdin to drain" round-trip the model
// would otherwise need for every fast shell invocation.
export const DEFAULT_EXEC_YIELD_MS = 10_000;
export const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const MAX_EXEC_YIELD_MS = 30_000;
const DEFAULT_EXEC_OUTPUT_TOKENS = 4_000;
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
  "state/electron-user-data",
]);

const APPROX_BYTES_PER_TOKEN = 4;
/**
 * Cheap byte-count → token estimate matching Codex's
 * `codex_utils_string::approx_token_count`. Off by a small constant from
 * any real tokenizer, but stable enough for "did this output get truncated".
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
  const resolvedStellaRoot = context?.stellaRoot?.trim()
    ? normalizeSnapshotRoot(context.stellaRoot)
    : null;
  if (
    resolvedCwd &&
    resolvedStellaRoot &&
    (resolvedCwd === resolvedStellaRoot ||
      resolvedCwd.startsWith(`${resolvedStellaRoot}${path.sep}`))
  ) {
    return resolvedStellaRoot;
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

const mergeProducedFiles = (
  ...groups: Array<ProducedFileRecord[] | undefined>
): ProducedFileRecord[] | undefined => {
  const out: ProducedFileRecord[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!group) continue;
    for (const file of group) {
      const key = `${file.kind.type}:${file.path}:${file.kind.type === "update" ? (file.kind.move_path ?? "") : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
  }
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

const takeCompletedProducedFiles = async (
  record: ManagedShellRecord,
): Promise<ProducedFileRecord[] | undefined> => {
  if (record.running || record.producedFilesReported) return undefined;
  record.producedFilesReported = true;
  return mergeProducedFiles(
    diffFileSnapshots(
      record.startSnapshot ?? null,
      await snapshotFiles(record.startSnapshot?.root ?? record.cwd),
    ),
    await diffExternalCandidateSnapshots(record.externalCandidateSnapshots),
  );
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

export function createShellState(
  secretStateRoot: string,
  options?: ShellStateOptions,
): ShellState {
  if (!secretStateRoot.trim()) {
    throw new Error("createShellState requires a secretStateRoot.");
  }

  return {
    shells: new Map(),
    secretStateRoot,
    stellaBrowserBinPath: options?.stellaBrowserBinPath,
    stellaOfficeBinPath: options?.stellaOfficeBinPath,
    stellaComputerCliPath: options?.stellaComputerCliPath,
    stellaConnectCliPath: options?.stellaConnectCliPath,
    cliBridgeSocketPath: options?.cliBridgeSocketPath,
    lastDeferredDeleteSweepAt: 0,
  };
}

const deferredDeleteHelperPath = (() => {
  const jsPath = fileURLToPath(
    new URL("./deferred-delete-cli.js", import.meta.url),
  );
  if (existsSync(jsPath)) {
    return jsPath;
  }
  const tsPath = fileURLToPath(
    new URL("./deferred-delete-cli.ts", import.meta.url),
  );
  if (existsSync(tsPath)) {
    return tsPath;
  }
  return "";
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
  },
) => {
  if (!deferredDeleteHelperPath) {
    return command;
  }
  const stellaBrowserBin =
    options?.stellaBrowserBinPath && existsSync(options.stellaBrowserBinPath)
      ? options.stellaBrowserBinPath
      : "";
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
__stella_dd() {
  "$STELLA_NODE_BIN" "$STELLA_DEFERRED_DELETE_HELPER" "$@"
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
${stellaBrowserBin ? `stella-browser() { "$STELLA_NODE_BIN" "$STELLA_BROWSER_BIN" "$@"; }` : ""}
${stellaOfficeBin ? `stella-office() { "$STELLA_NODE_BIN" "$STELLA_OFFICE_BIN" "$@"; }` : ""}
${stellaComputerCli ? `stella-computer() { "$STELLA_NODE_BIN" "$STELLA_COMPUTER_CLI" "$@"; }` : ""}
${stellaConnectCli ? `stella-connect() { "$STELLA_NODE_BIN" "$STELLA_CONNECT_CLI" "$@"; }` : ""}
${pythonFuncs}
export -f __stella_dd __stella_git_exec __stella_git_stage_feature_dependencies git rm rmdir unlink del erase rd powershell pwsh${stellaBrowserBin ? " stella-browser" : ""}${stellaOfficeBin ? " stella-office" : ""}${stellaComputerCli ? " stella-computer" : ""}${stellaConnectCli ? " stella-connect" : ""}${pythonExports} >/dev/null 2>&1 || true
`;

  return `${preamble}\n${rewriteDeleteBypassPatterns(command)}`;
};

const buildShellCommand = (command: string, state: ShellState): string => {
  if (process.platform === "win32") {
    return command;
  }
  return buildProtectedCommand(command, state);
};

const resolveStellaHomeFromState = (state: ShellState): string | undefined => {
  const stateRoot = path.resolve(state.secretStateRoot);
  if (path.basename(stateRoot) === "state") {
    return path.dirname(stateRoot);
  }
  return undefined;
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
    stellaHome: resolveStellaHomeFromState(state),
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
    stellaHome: resolveStellaHomeFromState(state),
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

const buildShellEnv = (
  envOverrides?: Record<string, string>,
  options?: {
    secretStateRoot?: string;
    stellaBrowserBinPath?: string;
    stellaOfficeBinPath?: string;
    stellaComputerCliPath?: string;
    stellaConnectCliPath?: string;
    cliBridgeSocketPath?: string;
  },
) => {
  const mergedEnv = {
    ...(envOverrides ? { ...process.env, ...envOverrides } : process.env),
    STELLA_NODE_BIN: process.execPath,
    STELLA_DEFERRED_DELETE_HELPER: deferredDeleteHelperPath,
    ...(options?.secretStateRoot
      ? { STELLA_STATE_DIR: options.secretStateRoot }
      : {}),
    ...(options?.stellaBrowserBinPath
      ? { STELLA_BROWSER_BIN: options.stellaBrowserBinPath }
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
    ...(options?.cliBridgeSocketPath
      ? { STELLA_CLI_BRIDGE_SOCK: options.cliBridgeSocketPath }
      : {}),
  };

  return setupEnvironment(mergedEnv).env;
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

const outputCharBudgetFromTokens = (value: unknown): number => {
  const tokens =
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(256, Math.floor(value))
      : DEFAULT_EXEC_OUTPUT_TOKENS;
  return Math.max(1_024, Math.min(tokens * 4, 200_000));
};

const truncateRecent = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}\n\n... (truncated)` : value;

type DrainedOutput = {
  text: string;
  originalLength: number;
  truncated: boolean;
};

const drainUnreadOutput = (
  record: ManagedShellRecord,
  maxChars: number,
): DrainedOutput => {
  const unread = record.unreadOutput;
  record.unreadOutput = "";
  const text = truncateRecent(unread, maxChars);
  return {
    text,
    originalLength: unread.length,
    truncated: unread.length > maxChars,
  };
};

const notifyShellActivity = (record: ManagedShellRecord) => {
  record.outputVersion += 1;
  const waiters = [...record.waiters];
  record.waiters.clear();
  for (const waiter of waiters) {
    waiter();
  }
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

export const normalizeComputerAgentShellCommand = (command: string) =>
  command
    .replace(
      /(?:^|&&\s*|\|\|\s*|;\s*)STELLA_BROWSER_SESSION=[^\s]+(?=\s+stella-browser\b)/g,
      (match) => match.replace(/STELLA_BROWSER_SESSION=[^\s]+\s*/, ""),
    )
    .replace(/\bstella-browser\s+--session(?:=|\s+)\S+\s*/g, "stella-browser ")
    .replace(/\s{2,}/g, " ")
    .trim();

const shouldUseStellaBrowserBridge = (command: string): boolean =>
  /\bstella-browser\b/.test(command) ||
  /\bSTELLA_BROWSER_SESSION=/.test(command);

const shouldUseStellaComputer = (command: string): boolean =>
  /\bstella-computer\b/.test(command);

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
    const record: ManagedShellRecord = {
      id,
      command,
      cwd,
      output: launch.error,
      running: false,
      exitCode: 127,
      startedAt: Date.now(),
      completedAt: Date.now(),
      unreadOutput: launch.error,
      outputVersion: 1,
      waiters: new Set(),
      stdinOpen: false,
      startSnapshot,
      externalCandidateSnapshots,
      kill: () => {},
    };
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
    running: true,
    exitCode: null,
    startedAt: Date.now(),
    completedAt: null,
    child,
    unreadOutput: "",
    outputVersion: 0,
    waiters: new Set(),
    stdinOpen: Boolean(child.stdin),
    startSnapshot,
    externalCandidateSnapshots,
    kill: () => {
      terminateShellProcess(child);
    },
  };

  const append = (data: Buffer) => {
    const chunk = data.toString();
    record.output = truncate(`${record.output}${chunk}`);
    record.unreadOutput = truncate(`${record.unreadOutput}${chunk}`, 200_000);
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
    record.output = truncate(`${record.output}${error.message}`);
    record.unreadOutput = truncate(
      `${record.unreadOutput}${error.message}`,
      200_000,
    );
    record.running = false;
    record.exitCode = record.exitCode ?? 1;
    record.completedAt = Date.now();
    record.stdinOpen = false;
    notifyShellActivity(record);
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
      const cleanedOutput = output
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
      context?.stellaRoot ??
      process.cwd(),
  );
  const envOverrides: Record<string, string> = {};
  const browserOwnerId =
    context?.agentId ?? context?.runId ?? context?.rootRunId;
  const stellaComputerSessionId = getStellaComputerSessionId(context);
  const localBinPaths = [
    path.join(path.resolve(cwd), "node_modules", ".bin"),
    ...(context?.stellaRoot
      ? [path.join(path.resolve(context.stellaRoot), "node_modules", ".bin")]
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

  if (shouldUseStellaBrowserBridge(command)) {
    command = normalizeComputerAgentShellCommand(command);
    Object.assign(envOverrides, getStellaBrowserBridgeEnv());
    if (browserOwnerId) {
      envOverrides.STELLA_BROWSER_OWNER_ID = browserOwnerId;
    }
  }

  if (shouldUseStellaComputer(command) && stellaComputerSessionId) {
    envOverrides.STELLA_COMPUTER_SESSION = stellaComputerSessionId;
  }

  return { command, cwd, envOverrides };
};

const resolveExecYieldTime = (
  value: unknown,
  defaultMs: number = DEFAULT_EXEC_YIELD_MS,
): number => {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : defaultMs;
  return Math.max(0, Math.min(raw, MAX_EXEC_YIELD_MS));
};

const buildExecToolPayload = (
  record: ManagedShellRecord,
  drained: DrainedOutput,
  callStartedAt: number,
): Record<string, unknown> => {
  const wallTimeSeconds = (Date.now() - callStartedAt) / 1000;
  // Mirrors Codex's unified-exec output schema: includes wall_time_seconds and
  // (when truncation happened) original_token_count so the model can detect
  // dropped output and react.
  const payload: Record<string, unknown> = {
    session_id: record.running ? record.id : null,
    running: record.running,
    exit_code: record.running ? null : record.exitCode,
    output: drained.text,
    wall_time_seconds: wallTimeSeconds,
    // Mirrors Codex: always report the pre-truncation token estimate so callers
    // can distinguish "small output" from "output omitted because it was huge".
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
  const prepared = resolveManagedShellCommand(args, context);
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

  const snapshotRoot = resolveShellSnapshotRoot(prepared.cwd, context);
  const beforeSideEffects = await snapshotShellSideEffects(
    { cmd: prepared.command, workdir: prepared.cwd },
    snapshotRoot,
    context,
  );
  let lastUpdateAt = 0;
  const maxOutputChars = outputCharBudgetFromTokens(args.max_output_tokens);
  const emitUpdate = (record: ManagedShellRecord) => {
    if (!onUpdate) return;
    const now = Date.now();
    if (record.running && now - lastUpdateAt < 250) return;
    lastUpdateAt = now;
    const unread = record.unreadOutput;
    const drained = {
      text: truncateRecent(unread, maxOutputChars),
      originalLength: unread.length,
      truncated: unread.length > maxOutputChars,
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
  const observedVersion = record.outputVersion;
  try {
    await waitForShellActivity(
      record,
      observedVersion,
      resolveExecYieldTime(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS),
      signal,
    );
  } catch (error) {
    return { error: (error as Error).message };
  }
  await settleCompletedShell(record, signal);

  const drained = drainUnreadOutput(record, maxOutputChars);
  const payload = buildExecToolPayload(record, drained, callStartedAt);
  const producedFiles = !record.running
    ? await takeCompletedProducedFiles(record)
    : undefined;
  return {
    result: payload,
    details: payload,
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
  if (context?.agentType === AGENT_IDS.INSTALL_UPDATE) {
    // The install-update agent runs only one-shot git commands via the
    // exec_command allowlist; no git invocation it makes needs interactive
    // stdin. Blocking write_stdin closes a small attack surface where the
    // agent could try to drive a shell session interactively.
    return {
      error: "Command blocked: install_update may not use write_stdin.",
    };
  }
  const sessionId = String(args.session_id ?? "").trim();
  if (!sessionId) {
    return { error: "session_id is required." };
  }
  const record = state.shells.get(sessionId);
  if (!record) {
    return { error: `Session not found: ${sessionId}` };
  }

  const chars = typeof args.chars === "string" ? args.chars : "";
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
      resolveExecYieldTime(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS),
      signal,
    );
  } catch (error) {
    return { error: (error as Error).message };
  }
  await settleCompletedShell(record, signal);

  const drained = drainUnreadOutput(
    record,
    outputCharBudgetFromTokens(args.max_output_tokens),
  );
  const payload = buildExecToolPayload(record, drained, callStartedAt);
  const producedFiles = await takeCompletedProducedFiles(record);
  return {
    result: payload,
    details: payload,
    ...(producedFiles ? { producedFiles } : {}),
  };
};

export const handleBash = async (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
  _signal?: AbortSignal,
): Promise<ToolResult> => {
  const prepared = resolveManagedShellCommand(args, context);
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
    const snapshotRoot = resolveShellSnapshotRoot(cwd, context);
    const beforeSideEffects = await snapshotShellSideEffects(
      { cmd: command, workdir: cwd },
      snapshotRoot,
      context,
    );
    const record = startShell(
      state,
      command,
      cwd,
      envOverrides,
      undefined,
      beforeSideEffects.rootSnapshot,
      beforeSideEffects.externalCandidateSnapshots,
    );
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

  const snapshotRoot = resolveShellSnapshotRoot(cwd, context);
  const beforeSideEffects = await snapshotShellSideEffects(
    { cmd: command, workdir: cwd },
    snapshotRoot,
    context,
  );
  const output = await runShell(state, command, cwd, timeout, envOverrides);
  const producedFiles = mergeProducedFiles(
    diffFileSnapshots(
      beforeSideEffects.rootSnapshot,
      await snapshotFiles(snapshotRoot),
    ),
    await diffExternalCandidateSnapshots(
      beforeSideEffects.externalCandidateSnapshots,
    ),
  );
  const extracted = extractOfficePreviewRef(output);
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
  const output = record.output || "(no output yet)";
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
    result: `Killed shell ${shellId}.\n\nOutput:\n${truncate(record.output)}`,
  };
};
