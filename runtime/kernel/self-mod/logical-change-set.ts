import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { diffArrays } from "diff";

import { mergeTextContent } from "./stella-source-control.js";

export type LogicalFileMode = "100644" | "100755" | "120000";

export type LogicalFileState =
  | { kind: "missing" }
  | {
      kind: "blob" | "symlink";
      mode: LogicalFileMode;
      contentBase64: string;
      /** Only present for validated UTF-8 text blobs without NUL bytes. */
      text?: string;
    };

export type LogicalFileConflict = {
  path: string;
  reason:
    | "text-conflict"
    | "add-delete-conflict"
    | "attribution-conflict"
    | "binary-or-mode-conflict";
  /** Bounded display excerpts; full states stay in controlled pending storage. */
  base: string | null;
  local: string | null;
  incoming: string | null;
};

export type LogicalMergedFile = {
  path: string;
  state: LogicalFileState;
};

type LineRange = { start: number; end: number };

export type FrozenLogicalChangeSet = {
  changeSetId: string;
  runId: string;
  createdAt: number;
  files: Array<{
    path: string;
    base: LogicalFileState;
    incoming: LogicalFileState;
    ranges: LineRange[];
    contentChanged: boolean;
    modeChanged: boolean;
  }>;
  conflicts: LogicalFileConflict[];
  concurrentRunIds: string[];
};

export type LogicalMergeResult =
  | {
      status: "clean";
      files: LogicalMergedFile[];
      selectedFiles: LogicalMergedFile[];
      noopPaths: string[];
    }
  | { status: "conflicts"; conflicts: LogicalFileConflict[] };

export type LogicalLiveTreeResult =
  | { status: "clean"; states: Map<string, LogicalFileState> }
  | { status: "conflicts"; conflicts: LogicalFileConflict[] };

export type MediatedWriteCapture = {
  runId: string;
  before: Map<string, LogicalFileState>;
  completeRepoSnapshot?: boolean;
};

type MutableLogicalFile = {
  base: LogicalFileState;
  incoming: LogicalFileState;
  conflict?: LogicalFileConflict;
};

type MutableLogicalRun = {
  files: Map<string, MutableLogicalFile>;
  concurrentRunIds: Set<string>;
};

const execFileAsync = promisify(execFile);

const CONFLICT_EXCERPT_MAX = 2_000;
const BINARY_RANGE: LineRange = { start: 0, end: Number.MAX_SAFE_INTEGER };

const cloneState = (state: LogicalFileState): LogicalFileState =>
  state.kind === "missing" ? { kind: "missing" } : { ...state };

const statesEqual = (a: LogicalFileState, b: LogicalFileState): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "missing" || b.kind === "missing") return true;
  return a.mode === b.mode && a.contentBase64 === b.contentBase64;
};

const validatedText = (bytes: Buffer): string | undefined => {
  if (bytes.includes(0)) return undefined;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
};

const stateFromBytes = (args: {
  kind: "blob" | "symlink";
  mode: LogicalFileMode;
  bytes: Buffer;
}): LogicalFileState => ({
  kind: args.kind,
  mode: args.mode,
  contentBase64: args.bytes.toString("base64"),
  ...(args.kind === "blob" && validatedText(args.bytes) !== undefined
    ? { text: validatedText(args.bytes) }
    : {}),
});

const stateExcerpt = (state: LogicalFileState): string | null => {
  if (state.kind === "missing") return null;
  const raw =
    state.text ??
    `<${state.kind} ${state.mode} ${Buffer.from(state.contentBase64, "base64").length} bytes>`;
  return raw.length <= CONFLICT_EXCERPT_MAX
    ? raw
    : `${raw.slice(0, CONFLICT_EXCERPT_MAX)}…`;
};

const conflictFor = (args: {
  path: string;
  reason: LogicalFileConflict["reason"];
  base: LogicalFileState;
  local: LogicalFileState;
  incoming: LogicalFileState;
}): LogicalFileConflict => ({
  path: args.path,
  reason: args.reason,
  base: stateExcerpt(args.base),
  local: stateExcerpt(args.local),
  incoming: stateExcerpt(args.incoming),
});

const mergeMode = (
  base: LogicalFileMode,
  local: LogicalFileMode,
  incoming: LogicalFileMode,
): LogicalFileMode | null => {
  if (local === incoming) return local;
  if (local === base) return incoming;
  if (incoming === base) return local;
  return null;
};

const mergeState = (args: {
  path: string;
  base: LogicalFileState;
  local: LogicalFileState;
  incoming: LogicalFileState;
  conflictReason?: LogicalFileConflict["reason"];
}):
  | { status: "clean"; state: LogicalFileState }
  | { status: "conflict"; conflict: LogicalFileConflict } => {
  if (statesEqual(args.local, args.incoming)) {
    return { status: "clean", state: cloneState(args.local) };
  }
  if (statesEqual(args.local, args.base)) {
    return { status: "clean", state: cloneState(args.incoming) };
  }
  if (statesEqual(args.incoming, args.base)) {
    return { status: "clean", state: cloneState(args.local) };
  }
  if (
    args.base.kind === "blob" &&
    args.local.kind === "blob" &&
    args.incoming.kind === "blob" &&
    args.base.text !== undefined &&
    args.local.text !== undefined &&
    args.incoming.text !== undefined
  ) {
    const mode = mergeMode(args.base.mode, args.local.mode, args.incoming.mode);
    const merged = mergeTextContent(
      args.base.text,
      args.local.text,
      args.incoming.text,
    );
    if (mode && merged.status === "clean") {
      return {
        status: "clean",
        state: stateFromBytes({
          kind: "blob",
          mode,
          bytes: Buffer.from(merged.content, "utf8"),
        }),
      };
    }
  }
  const hasMissing =
    args.base.kind === "missing" ||
    args.local.kind === "missing" ||
    args.incoming.kind === "missing";
  const allText = [args.base, args.local, args.incoming].every(
    (state) => state.kind === "blob" && state.text !== undefined,
  );
  return {
    status: "conflict",
    conflict: conflictFor({
      ...args,
      reason:
        args.conflictReason ??
        (hasMissing
          ? "add-delete-conflict"
          : allText
            ? "text-conflict"
            : "binary-or-mode-conflict"),
    }),
  };
};

const changedRanges = (
  base: LogicalFileState,
  incoming: LogicalFileState,
): LineRange[] => {
  if (
    base.kind !== "blob" ||
    incoming.kind !== "blob" ||
    base.text === undefined ||
    incoming.text === undefined
  ) {
    return [BINARY_RANGE];
  }
  const baseLines = base.text.split(/(?<=\n)/);
  const incomingLines = incoming.text.split(/(?<=\n)/);
  const ranges: LineRange[] = [];
  let baseCursor = 0;
  for (const change of diffArrays(baseLines, incomingLines)) {
    if (change.added) {
      ranges.push({ start: baseCursor, end: baseCursor });
    } else if (change.removed) {
      const end = baseCursor + change.value.length;
      ranges.push({ start: baseCursor, end });
      baseCursor = end;
    } else {
      baseCursor += change.value.length;
    }
  }
  const normalized: LineRange[] = [];
  for (const range of ranges) {
    const previous = normalized.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      normalized.push({ ...range });
    }
  }
  return normalized;
};

const rangesOverlap = (a: LineRange, b: LineRange): boolean => {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
};

export const readWorkingTreeFileState = async (
  absolutePath: string,
): Promise<LogicalFileState> => {
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath, { encoding: "buffer" });
      return stateFromBytes({ kind: "symlink", mode: "120000", bytes: target });
    }
    if (!stat.isFile()) return { kind: "missing" };
    const bytes = await fs.readFile(absolutePath);
    return stateFromBytes({
      kind: "blob",
      mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
      bytes,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
};

export class LogicalSelfModChangeSetStore {
  private readonly activeRuns = new Map<string, MutableLogicalRun>();
  private readonly frozen = new Map<string, FrozenLogicalChangeSet>();
  private readonly appliedConcurrent = new Map<
    string,
    FrozenLogicalChangeSet
  >();

  constructor(private readonly repoRoot: string) {}

  beginRun(runId: string): void {
    const run: MutableLogicalRun = {
      files: new Map(),
      concurrentRunIds: new Set(this.activeRuns.keys()),
    };
    for (const [otherRunId, otherRun] of this.activeRuns) {
      otherRun.concurrentRunIds.add(runId);
      run.concurrentRunIds.add(otherRunId);
    }
    this.activeRuns.set(runId, run);
  }

  cancelRun(runId: string): void {
    this.activeRuns.delete(runId);
    this.pruneAppliedConcurrent();
  }

  private normalizePath(candidate: string): string | null {
    const absolute = path.resolve(candidate);
    const relative = path.relative(this.repoRoot, absolute).replace(/\\/g, "/");
    if (!relative || relative === "." || relative.startsWith("../"))
      return null;
    return relative;
  }

  async beginWrite(
    runId: string,
    absolutePaths: Iterable<string>,
    options?: { captureAll?: boolean },
  ): Promise<MediatedWriteCapture | null> {
    const run = this.activeRuns.get(runId);
    if (!run) return null;
    for (const [otherRunId, otherRun] of this.activeRuns) {
      if (otherRunId === runId) continue;
      run.concurrentRunIds.add(otherRunId);
      otherRun.concurrentRunIds.add(runId);
    }
    const before = new Map<string, LogicalFileState>();
    if (options?.captureAll) {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: this.repoRoot, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
      );
      for (const relative of Buffer.from(stdout).toString("utf8").split("\0")) {
        if (!relative) continue;
        before.set(
          relative,
          await readWorkingTreeFileState(path.join(this.repoRoot, relative)),
        );
      }
    }
    for (const candidate of absolutePaths) {
      const relative = this.normalizePath(candidate);
      if (!relative || before.has(relative)) continue;
      before.set(
        relative,
        await readWorkingTreeFileState(path.join(this.repoRoot, relative)),
      );
    }
    return {
      runId,
      before,
      ...(options?.captureAll ? { completeRepoSnapshot: true } : {}),
    };
  }

  async finishWrite(
    capture: MediatedWriteCapture | null,
    additionalAbsolutePaths: Iterable<string> = [],
  ): Promise<void> {
    if (!capture) return;
    const run = this.activeRuns.get(capture.runId);
    if (!run) return;
    // For all-repo captures, DISCOVER files created during the turn
    // independently of any engine-reported path list: enumerate the current
    // tracked + untracked working tree and treat every path absent from the
    // pre-turn snapshot as a creation (base = missing) so the diff loop below
    // attributes it. This is essential for external engines (e.g. Claude Code)
    // whose Bash-side `>` / `mkdir` writes are invisible to their tool-event
    // file collectors. Runs while the caller still holds the mutation lock.
    if (capture.completeRepoSnapshot) {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: this.repoRoot, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
      );
      for (const relative of Buffer.from(stdout).toString("utf8").split("\0")) {
        if (!relative || capture.before.has(relative)) continue;
        capture.before.set(relative, { kind: "missing" });
      }
    }
    for (const candidate of additionalAbsolutePaths) {
      const relative = this.normalizePath(candidate);
      if (!relative || capture.before.has(relative)) continue;
      if (capture.completeRepoSnapshot) {
        capture.before.set(relative, { kind: "missing" });
        continue;
      }
      const after = await readWorkingTreeFileState(
        path.join(this.repoRoot, relative),
      );
      run.files.set(relative, {
        base: { kind: "missing" },
        incoming: after,
        conflict: conflictFor({
          path: relative,
          reason: "attribution-conflict",
          base: { kind: "missing" },
          local: { kind: "missing" },
          incoming: after,
        }),
      });
    }
    for (const [relative, before] of capture.before) {
      const after = await readWorkingTreeFileState(
        path.join(this.repoRoot, relative),
      );
      if (statesEqual(after, before)) continue;
      const existing = run.files.get(relative);
      if (!existing) {
        run.files.set(relative, {
          base: cloneState(before),
          incoming: cloneState(after),
        });
        continue;
      }
      if (existing.conflict) continue;
      const accumulated = mergeState({
        path: relative,
        base: before,
        local: existing.incoming,
        incoming: after,
        conflictReason: "attribution-conflict",
      });
      if (accumulated.status === "clean") {
        existing.incoming = accumulated.state;
      } else {
        existing.conflict = accumulated.conflict;
      }
    }
  }

  /**
   * Absolute paths whose CURRENT working-tree state differs from this capture's
   * pre-turn snapshot — i.e. EXACTLY the delta this run authored while it held
   * the lease (created, modified, or deleted files), including all-repo
   * created-file discovery. Read-only: it does not mutate run state. This is the
   * same source of truth as the logical changeset, so callers can feed the HMR
   * contention tracker the run's authored delta and never pre-existing dirt
   * that was already present before the lease was acquired.
   */
  async changedPathsForCapture(
    capture: MediatedWriteCapture | null,
  ): Promise<string[]> {
    if (!capture) return [];
    const candidates = new Map(capture.before);
    if (capture.completeRepoSnapshot) {
      const { stdout } = await execFileAsync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: this.repoRoot, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
      );
      for (const relative of Buffer.from(stdout).toString("utf8").split("\0")) {
        if (!relative || candidates.has(relative)) continue;
        candidates.set(relative, { kind: "missing" });
      }
    }
    const changed: string[] = [];
    for (const [relative, before] of candidates) {
      const after = await readWorkingTreeFileState(
        path.join(this.repoRoot, relative),
      );
      if (statesEqual(after, before)) continue;
      changed.push(path.join(this.repoRoot, relative));
    }
    return changed;
  }

  finalizeRun(runId: string): FrozenLogicalChangeSet | null {
    const run = this.activeRuns.get(runId);
    this.activeRuns.delete(runId);
    if (!run || run.files.size === 0) return null;
    const changeSet: FrozenLogicalChangeSet = {
      changeSetId: `selfmod-${crypto.randomUUID()}`,
      runId,
      createdAt: Date.now(),
      files: [...run.files.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([filePath, state]) => ({
          path: filePath,
          base: cloneState(state.base),
          incoming: cloneState(state.incoming),
          ranges: changedRanges(state.base, state.incoming),
          contentChanged:
            state.base.kind !== state.incoming.kind ||
            (state.base.kind !== "missing" &&
              state.incoming.kind !== "missing" &&
              state.base.contentBase64 !== state.incoming.contentBase64),
          modeChanged:
            state.base.kind !== state.incoming.kind ||
            (state.base.kind !== "missing" &&
              state.incoming.kind !== "missing" &&
              state.base.mode !== state.incoming.mode),
        })),
      conflicts: [...run.files.values()].flatMap((state) =>
        state.conflict ? [state.conflict] : [],
      ),
      concurrentRunIds: [...run.concurrentRunIds].sort(),
    };
    this.frozen.set(changeSet.changeSetId, changeSet);
    return changeSet;
  }

  get(changeSetId: string): FrozenLogicalChangeSet | null {
    return this.frozen.get(changeSetId) ?? null;
  }

  listPending(): FrozenLogicalChangeSet[] {
    return [...this.frozen.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  restore(changeSet: FrozenLogicalChangeSet): void {
    if (!changeSet.changeSetId || this.frozen.has(changeSet.changeSetId))
      return;
    this.frozen.set(changeSet.changeSetId, {
      ...changeSet,
      files: changeSet.files.map((file) => ({
        ...file,
        base: cloneState(file.base),
        incoming: cloneState(file.incoming),
        ranges: file.ranges.map((range) => ({ ...range })),
      })),
      conflicts: changeSet.conflicts.map((conflict) => ({ ...conflict })),
      concurrentRunIds: [...changeSet.concurrentRunIds],
    });
  }

  discard(changeSetId: string): FrozenLogicalChangeSet | null {
    const changeSet = this.frozen.get(changeSetId) ?? null;
    this.frozen.delete(changeSetId);
    this.pruneAppliedConcurrent();
    return changeSet;
  }

  markApplied(changeSetId: string): void {
    const changeSet = this.frozen.get(changeSetId);
    if (changeSet) this.appliedConcurrent.set(changeSetId, changeSet);
    this.frozen.delete(changeSetId);
    this.pruneAppliedConcurrent();
  }

  private pruneAppliedConcurrent(): void {
    const neededRunIds = new Set<string>();
    for (const run of this.activeRuns.values()) {
      for (const runId of run.concurrentRunIds) neededRunIds.add(runId);
    }
    for (const changeSet of this.frozen.values()) {
      for (const runId of changeSet.concurrentRunIds) neededRunIds.add(runId);
    }
    for (const [changeSetId, changeSet] of this.appliedConcurrent) {
      if (!neededRunIds.has(changeSet.runId))
        this.appliedConcurrent.delete(changeSetId);
    }
  }

  async mergeAgainst(
    changeSetId: string,
    readHeadFile: (path: string) => Promise<LogicalFileState>,
  ): Promise<LogicalMergeResult> {
    const changeSet = this.frozen.get(changeSetId);
    if (!changeSet) {
      return { status: "clean", files: [], selectedFiles: [], noopPaths: [] };
    }
    if (changeSet.conflicts.length > 0) {
      return { status: "conflicts", conflicts: changeSet.conflicts };
    }
    const concurrentSets = [
      ...this.frozen.values(),
      ...this.appliedConcurrent.values(),
    ].filter(
      (other) =>
        other.changeSetId !== changeSet.changeSetId &&
        changeSet.concurrentRunIds.includes(other.runId),
    );
    for (const file of changeSet.files) {
      const overlapping = concurrentSets
        .flatMap((other) => other.files)
        .find(
          (otherFile) =>
            otherFile.path === file.path &&
            (file.contentChanged ?? true) &&
            (otherFile.contentChanged ?? true) &&
            file.ranges.some((a) =>
              otherFile.ranges.some((b) => rangesOverlap(a, b)),
            ),
        );
      if (overlapping) {
        return {
          status: "conflicts",
          conflicts: [
            conflictFor({
              path: file.path,
              reason:
                file.base.kind === "blob" &&
                file.incoming.kind === "blob" &&
                file.base.text !== undefined &&
                file.incoming.text !== undefined
                  ? "text-conflict"
                  : "binary-or-mode-conflict",
              base: file.base,
              local: await readHeadFile(file.path),
              incoming: file.incoming,
            }),
          ],
        };
      }
    }
    const files: LogicalMergedFile[] = [];
    const selectedFiles: LogicalMergedFile[] = [];
    const noopPaths: string[] = [];
    const conflicts: LogicalFileConflict[] = [];
    for (const file of changeSet.files) {
      const local = await readHeadFile(file.path);
      const merged = mergeState({
        path: file.path,
        base: file.base,
        local,
        incoming: file.incoming,
      });
      if (merged.status === "conflict") {
        conflicts.push(merged.conflict);
        continue;
      }
      const selected = { path: file.path, state: merged.state };
      selectedFiles.push(selected);
      if (statesEqual(merged.state, local)) {
        noopPaths.push(file.path);
      } else {
        files.push(selected);
      }
    }
    return conflicts.length > 0
      ? { status: "conflicts", conflicts }
      : { status: "clean", files, selectedFiles, noopPaths };
  }

  async buildLiveTree(
    extraPaths: Iterable<string>,
    readHeadFile: (path: string) => Promise<LogicalFileState>,
    options?: { excludeChangeSetIds?: Iterable<string> },
  ): Promise<LogicalLiveTreeResult> {
    const paths = new Set(extraPaths);
    const excluded = new Set(options?.excludeChangeSetIds ?? []);
    const pendingFiles = [
      ...[...this.frozen.values()]
        .filter((changeSet) => !excluded.has(changeSet.changeSetId))
        .flatMap((changeSet) => changeSet.files),
      ...[...this.activeRuns.values()].flatMap((run) =>
        [...run.files.entries()].map(([filePath, file]) => ({
          path: filePath,
          base: file.base,
          incoming: file.incoming,
        })),
      ),
    ];
    for (const file of pendingFiles) paths.add(file.path);
    const states = new Map<string, LogicalFileState>();
    const conflicts: LogicalFileConflict[] = [];
    for (const filePath of paths) {
      let current = await readHeadFile(filePath);
      for (const file of pendingFiles) {
        if (file.path !== filePath) continue;
        const merged = mergeState({
          path: filePath,
          base: file.base,
          local: current,
          incoming: file.incoming,
        });
        if (merged.status === "conflict") {
          conflicts.push(merged.conflict);
          break;
        }
        current = merged.state;
      }
      if (!conflicts.some((conflict) => conflict.path === filePath)) {
        states.set(filePath, current);
      }
    }
    return conflicts.length > 0
      ? { status: "conflicts", conflicts }
      : { status: "clean", states };
  }
}
