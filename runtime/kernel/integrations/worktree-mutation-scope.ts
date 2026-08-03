import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setupGitEnvironment } from "../../git-environment.js";
import type { FileChangeRecord } from "../../contracts/file-changes.js";

const execFileAsync = promisify(execFile);

type WorktreeEntry = {
  path: string;
  status: string;
  movePath?: string;
};

export type WorktreeMutationSnapshot = {
  repoRoot: string;
  head: string | null;
  /** Symbolic branch ref, or null for detached HEAD. */
  headRef: string | null;
  entries: Map<string, WorktreeEntry>;
  fingerprints: Map<string, string | null>;
};

export type WorktreeMutationDiff = {
  fileChanges: FileChangeRecord[];
  headChanged: boolean;
  beforeHead: string | null;
  afterHead: string | null;
};

const normalizeGitPath = (value: string): string => value.replace(/\\/g, "/");

const statusKeyForEntry = (entry: WorktreeEntry): string =>
  entry.movePath ?? entry.path;

const absoluteRepoPath = (repoRoot: string, repoRelativePath: string): string =>
  path.resolve(repoRoot, repoRelativePath);

/**
 * Parse porcelain-v1 `-z` output. In `-z` mode Git omits the textual ` -> `
 * marker and reverses rename/copy fields: destination NUL source NUL. Paths
 * are otherwise byte-for-byte and never shell-quoted, so spaces, arrows, and
 * newlines in filenames cannot corrupt attribution.
 */
const parseGitStatusZ = (stdout: string): Map<string, WorktreeEntry> => {
  const entries = new Map<string, WorktreeEntry>();
  const fields = stdout.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    const firstPath = normalizeGitPath(field.slice(3));
    if (!firstPath) continue;
    const isRenameOrCopy = /[RC]/u.test(status);
    if (isRenameOrCopy) {
      const sourcePath = normalizeGitPath(fields[index + 1] ?? "");
      index += 1;
      if (!sourcePath) continue;
      const entry: WorktreeEntry = {
        status,
        path: sourcePath,
        movePath: firstPath,
      };
      entries.set(statusKeyForEntry(entry), entry);
      continue;
    }
    const entry: WorktreeEntry = { status, path: firstPath };
    entries.set(statusKeyForEntry(entry), entry);
  }
  return entries;
};

const runGit = async (
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> => {
  const { env, gitLocation } = setupGitEnvironment();
  try {
    const result = await execFileAsync(gitLocation, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout: String(result.stdout ?? "") };
  } catch {
    return { ok: false, stdout: "" };
  }
};

const fingerprintFile = async (
  repoRoot: string,
  repoRelativePath: string,
): Promise<string | null> => {
  try {
    const data = await readFile(absoluteRepoPath(repoRoot, repoRelativePath));
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
};

/**
 * Capture the externally-visible mutation state for a Git checkout. The
 * mutation root is deliberately independent from the engine's execution cwd:
 * General agents commonly execute from the user's home directory while the
 * Apply/HMR authority is the Stella checkout.
 */
export const captureWorktreeMutationSnapshot = async (
  mutationRoot: string | undefined,
): Promise<WorktreeMutationSnapshot | null> => {
  const requestedRoot = mutationRoot?.trim();
  if (!requestedRoot) return null;
  const topLevel = await runGit(requestedRoot, [
    "rev-parse",
    "--show-toplevel",
  ]);
  const repoRoot = topLevel.ok ? topLevel.stdout.trim() : "";
  if (!repoRoot) return null;
  const [status, head, headRef] = await Promise.all([
    runGit(repoRoot, [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]),
    runGit(repoRoot, ["symbolic-ref", "--quiet", "HEAD"]),
  ]);
  if (!status.ok) return null;
  const entries = parseGitStatusZ(status.stdout);
  const fingerprints = new Map<string, string | null>();
  await Promise.all(
    [...entries.entries()].map(async ([key, entry]) => {
      fingerprints.set(
        key,
        await fingerprintFile(repoRoot, statusKeyForEntry(entry)),
      );
    }),
  );
  return {
    repoRoot,
    head: head.ok ? head.stdout.trim() || null : null,
    headRef: headRef.ok ? headRef.stdout.trim() || null : null,
    entries,
    fingerprints,
  };
};

/**
 * Native engines are free to invoke Git directly, but Stella's Apply/Undo
 * contract needs the run's changes to remain uncommitted until StoreMod
 * creates the attributed contribution. If HEAD moved during the epoch,
 * convert those native commits back into staged worktree changes without
 * touching file contents or the pre-existing index.
 */
export const restoreSnapshotHeadForSelfMod = async (
  before: WorktreeMutationSnapshot | null,
): Promise<boolean> => {
  if (!before?.head) return false;
  const current = await runGit(before.repoRoot, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const currentHead = current.ok ? current.stdout.trim() : "";
  if (!currentHead || currentHead === before.head) return false;
  const currentRefResult = await runGit(before.repoRoot, [
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ]);
  const currentRef = currentRefResult.ok
    ? currentRefResult.stdout.trim() || null
    : null;
  if (currentRef !== before.headRef) {
    throw new Error(
      `Claude Code changed the checked-out Git branch in ${before.repoRoot}. Stella will not rewrite a different branch while adopting self-mod changes; restore ${before.headRef ?? "the original detached HEAD"} before retrying.`,
    );
  }
  const reset = await runGit(before.repoRoot, ["reset", "--soft", before.head]);
  if (!reset.ok) {
    throw new Error(
      `Claude Code changed Git HEAD in ${before.repoRoot}, and Stella could not restore the self-mod baseline. The native commit was not adopted into Apply/Undo.`,
    );
  }
  return true;
};

const entryToChange = (
  snapshot: WorktreeMutationSnapshot,
  entry: WorktreeEntry,
): FileChangeRecord => {
  const status = entry.status;
  const changePath = absoluteRepoPath(snapshot.repoRoot, entry.path);
  const movePath = entry.movePath
    ? absoluteRepoPath(snapshot.repoRoot, entry.movePath)
    : undefined;
  if (status === "??" || status.includes("A")) {
    return { path: movePath ?? changePath, kind: { type: "add" } };
  }
  if (status.includes("D") && !status.includes("A")) {
    return { path: changePath, kind: { type: "delete" } };
  }
  return {
    path: changePath,
    kind: {
      type: "update",
      ...(movePath ? { move_path: movePath } : {}),
    },
  };
};

/**
 * Return the net paths mutated between two snapshots. A pre-existing dirty
 * file is reported only when its status/path/content fingerprint changed;
 * untouched user WIP therefore stays outside the agent's ownership set.
 */
export const diffWorktreeMutationSnapshots = (
  before: WorktreeMutationSnapshot | null,
  after: WorktreeMutationSnapshot | null,
): WorktreeMutationDiff => {
  const beforeHead = before?.head ?? null;
  const afterHead = after?.head ?? null;
  if (!before || !after || before.repoRoot !== after.repoRoot) {
    return {
      fileChanges: [],
      headChanged: Boolean(beforeHead && afterHead && beforeHead !== afterHead),
      beforeHead,
      afterHead,
    };
  }
  const fileChanges: FileChangeRecord[] = [];
  const keys = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const key of keys) {
    const beforeEntry = before.entries.get(key);
    const afterEntry = after.entries.get(key);
    const beforeFingerprint = before.fingerprints.get(key);
    const afterFingerprint = after.fingerprints.get(key);
    if (!beforeEntry && afterEntry) {
      fileChanges.push(entryToChange(after, afterEntry));
      continue;
    }
    if (beforeEntry && !afterEntry) {
      const absolutePath = absoluteRepoPath(
        before.repoRoot,
        statusKeyForEntry(beforeEntry),
      );
      fileChanges.push({
        path: absolutePath,
        kind: fs.existsSync(absolutePath)
          ? { type: "update" }
          : { type: "delete" },
      });
      continue;
    }
    if (!beforeEntry || !afterEntry) continue;
    if (
      beforeEntry.status !== afterEntry.status ||
      beforeEntry.path !== afterEntry.path ||
      beforeEntry.movePath !== afterEntry.movePath ||
      beforeFingerprint !== afterFingerprint
    ) {
      fileChanges.push(entryToChange(after, afterEntry));
    }
  }
  return {
    fileChanges,
    headChanged: Boolean(
      before.head && after.head && before.head !== after.head,
    ),
    beforeHead,
    afterHead,
  };
};
