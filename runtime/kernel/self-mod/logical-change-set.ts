import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { diffArrays } from "diff";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { mergeTextContent } from "./stella-source-control.js";

export type LogicalFileContent = string | null;

export type LogicalFileConflict = {
  path: string;
  reason: "text-conflict" | "add-delete-conflict" | "attribution-conflict";
  base: LogicalFileContent;
  local: LogicalFileContent;
  incoming: LogicalFileContent;
};

export type LogicalMergedFile = {
  path: string;
  content?: string;
  deleted?: boolean;
};

export type FrozenLogicalChangeSet = {
  changeSetId: string;
  runId: string;
  files: Array<{
    path: string;
    base: LogicalFileContent;
    incoming: LogicalFileContent;
    ranges: Array<{ start: number; end: number }>;
  }>;
  conflicts: LogicalFileConflict[];
  concurrentRunIds: string[];
};

export type LogicalMergeResult =
  | { status: "clean"; files: LogicalMergedFile[]; noopPaths: string[] }
  | { status: "conflicts"; conflicts: LogicalFileConflict[] };

export type MediatedWriteCapture = {
  runId: string;
  before: Map<string, LogicalFileContent>;
  completeRepoSnapshot?: boolean;
};

const execFileAsync = promisify(execFile);

type MutableLogicalFile = {
  base: LogicalFileContent;
  incoming: LogicalFileContent;
  conflict?: LogicalFileConflict;
};

type MutableLogicalRun = {
  files: Map<string, MutableLogicalFile>;
  concurrentRunIds: Set<string>;
};

const changedLineRanges = (
  base: LogicalFileContent,
  incoming: LogicalFileContent,
): Array<{ start: number; end: number }> => {
  const baseLines = (base ?? "").split(/(?<=\n)/);
  const incomingLines = (incoming ?? "").split(/(?<=\n)/);
  const changes = diffArrays(baseLines, incomingLines);
  const ranges: Array<{ start: number; end: number }> = [];
  let baseCursor = 0;
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]!;
    if (change.added) {
      ranges.push({ start: baseCursor, end: baseCursor });
      continue;
    }
    if (change.removed) {
      const end = baseCursor + change.value.length;
      ranges.push({ start: baseCursor, end });
      baseCursor = end;
      continue;
    }
    baseCursor += change.value.length;
  }
  return ranges;
};

const rangesOverlap = (
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean => {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
};

const readFileOrNull = async (
  absolutePath: string,
): Promise<LogicalFileContent> => {
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const mergeFile = (args: {
  path: string;
  base: LogicalFileContent;
  local: LogicalFileContent;
  incoming: LogicalFileContent;
  conflictReason?: LogicalFileConflict["reason"];
}):
  | { status: "clean"; content: LogicalFileContent }
  | { status: "conflict"; conflict: LogicalFileConflict } => {
  if (args.local === args.incoming) {
    return { status: "clean", content: args.local };
  }
  if (args.local === args.base) {
    return { status: "clean", content: args.incoming };
  }
  if (args.incoming === args.base) {
    return { status: "clean", content: args.local };
  }
  if (args.base !== null && args.local !== null && args.incoming !== null) {
    const merged = mergeTextContent(args.base, args.local, args.incoming);
    if (merged.status === "clean") {
      return { status: "clean", content: merged.content };
    }
  }
  return {
    status: "conflict",
    conflict: {
      path: args.path,
      reason:
        args.conflictReason ??
        (args.base === null || args.local === null || args.incoming === null
          ? "add-delete-conflict"
          : "text-conflict"),
      base: args.base,
      local: args.local,
      incoming: args.incoming,
    },
  };
};

/**
 * Logical authored-delta store for one shared working tree.
 *
 * A run's first pre-write content is its per-file base. Each later mediated
 * write is represented as `before -> after` and replayed onto the run's
 * synthetic incoming state. This strips bytes merely inherited from another
 * run's live working-tree edits while retaining this run's own hunks.
 */
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
    if (!this.activeRuns.has(runId)) return null;
    const run = this.activeRuns.get(runId)!;
    for (const [otherRunId, otherRun] of this.activeRuns) {
      if (otherRunId === runId) continue;
      run.concurrentRunIds.add(otherRunId);
      otherRun.concurrentRunIds.add(runId);
    }
    const before = new Map<string, LogicalFileContent>();
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
          await readFileOrNull(path.join(this.repoRoot, relative)),
        );
      }
    }
    for (const candidate of absolutePaths) {
      const relative = this.normalizePath(candidate);
      if (!relative || before.has(relative)) continue;
      before.set(
        relative,
        await readFileOrNull(path.join(this.repoRoot, relative)),
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
    for (const candidate of additionalAbsolutePaths) {
      const relative = this.normalizePath(candidate);
      if (!relative || capture.before.has(relative)) continue;
      if (capture.completeRepoSnapshot) {
        capture.before.set(relative, null);
        continue;
      }
      // A post-only path cannot be attributed safely. Preserve it as an
      // explicit conflict instead of silently sweeping its whole-file bytes.
      const after = await readFileOrNull(path.join(this.repoRoot, relative));
      run.files.set(relative, {
        base: null,
        incoming: after,
        conflict: {
          path: relative,
          reason: "attribution-conflict",
          base: null,
          local: null,
          incoming: after,
        },
      });
    }
    for (const [relative, before] of capture.before) {
      const after = await readFileOrNull(path.join(this.repoRoot, relative));
      if (after === before) continue;
      const existing = run.files.get(relative);
      if (!existing) {
        run.files.set(relative, { base: before, incoming: after });
        continue;
      }
      if (existing.conflict) continue;
      const accumulated = mergeFile({
        path: relative,
        base: before,
        local: existing.incoming,
        incoming: after,
        conflictReason: "attribution-conflict",
      });
      if (accumulated.status === "clean") {
        existing.incoming = accumulated.content;
      } else {
        existing.conflict = accumulated.conflict;
      }
    }
  }

  finalizeRun(runId: string): FrozenLogicalChangeSet | null {
    const run = this.activeRuns.get(runId);
    this.activeRuns.delete(runId);
    if (!run || run.files.size === 0) return null;
    const changeSet: FrozenLogicalChangeSet = {
      changeSetId: `selfmod-${crypto.randomUUID()}`,
      runId,
      files: [...run.files.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([filePath, state]) => ({
          path: filePath,
          base: state.base,
          incoming: state.incoming,
          ranges: changedLineRanges(state.base, state.incoming),
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

  discard(changeSetId: string): void {
    this.frozen.delete(changeSetId);
    this.pruneAppliedConcurrent();
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
      if (!neededRunIds.has(changeSet.runId)) {
        this.appliedConcurrent.delete(changeSetId);
      }
    }
  }

  async mergeAgainst(
    changeSetId: string,
    readHeadFile: (path: string) => Promise<LogicalFileContent>,
  ): Promise<LogicalMergeResult> {
    const changeSet = this.frozen.get(changeSetId);
    if (!changeSet) return { status: "clean", files: [], noopPaths: [] };
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
            file.ranges.some((a) =>
              otherFile.ranges.some((b) => rangesOverlap(a, b)),
            ),
        );
      if (overlapping) {
        return {
          status: "conflicts",
          conflicts: [
            {
              path: file.path,
              reason: "text-conflict",
              base: file.base,
              local: await readHeadFile(file.path),
              incoming: file.incoming,
            },
          ],
        };
      }
    }
    const files: LogicalMergedFile[] = [];
    const noopPaths: string[] = [];
    const conflicts: LogicalFileConflict[] = [];
    for (const file of changeSet.files) {
      const local = await readHeadFile(file.path);
      const merged = mergeFile({
        path: file.path,
        base: file.base,
        local,
        incoming: file.incoming,
      });
      if (merged.status === "conflict") {
        conflicts.push(merged.conflict);
        continue;
      }
      if (merged.content === local) {
        noopPaths.push(file.path);
        continue;
      }
      files.push(
        merged.content === null
          ? { path: file.path, deleted: true }
          : { path: file.path, content: merged.content },
      );
    }
    return conflicts.length > 0
      ? { status: "conflicts", conflicts }
      : { status: "clean", files, noopPaths };
  }
}
