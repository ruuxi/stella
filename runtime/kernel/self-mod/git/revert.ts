import {
  assertGitRepository,
  normalizeGitPath,
  parseNulList,
  runGit,
  runGitStatus,
  toTrimmedString,
  uniqueSafeRepoPaths,
} from "./exec.js";
import { withRepoCommitLock } from "./commit-lock.js";
import {
  STELLA_COMMIT_GREP_PATTERN,
  isStellaSelfModCommitMessage,
  parseStellaCommitTrailers,
} from "./trailers.js";
import {
  getGitHead,
  getLastSelfModCommitHash,
  listGitDirtyFiles,
} from "./log.js";

export type SelfModRevertResult = {
  commitHash: string;
  revertedCommitHashes: string[];
  message: string;
  /**
   * Conversation id parsed from the reverted commit's
   * `Stella-Conversation` trailer. Used by the worker to insert a
   * `self_mod_reverts` row so the revert-notice hook can inform the
   * orchestrator on the next user turn. Null when the commit predates
   * the trailer or had no conversation attribution.
   */
  conversationId?: string | null;
  /**
   * Engine thread key of the agent that authored the reverted commit
   * (`Stella-Thread` trailer). Used by the revert-notice hook to also
   * inject the reminder if the orchestrator later resumes that same
   * thread via `send_input`. Null when the commit predates the trailer
   * — falls back to orchestrator-only routing in that case.
   */
  originThreadKey?: string | null;
  /** Files touched by the reverted commit(s). Used for the hidden reminder text. */
  files?: string[];
};

export type GitRollbackSinceResult =
  | {
      status: "rolled-back";
      headCommit: string | null;
      restoredFiles: string[];
    }
  | {
      status: "skipped";
      reason: string;
      headCommit?: string | null;
    };

const hasMergeInProgress = async (repoRoot: string): Promise<boolean> => {
  const result = await runGitStatus(repoRoot, [
    "rev-parse",
    "-q",
    "--verify",
    "MERGE_HEAD",
  ]);
  return result.exitCode === 0;
};

const abortMergeIfNeeded = async (repoRoot: string): Promise<boolean> => {
  if (!(await hasMergeInProgress(repoRoot))) return false;
  await runGit(repoRoot, ["merge", "--abort"]);
  return true;
};

const restoreGitPaths = async (
  repoRoot: string,
  paths: string[] | undefined,
): Promise<string[]> => {
  const safePaths = uniqueSafeRepoPaths(paths);
  if (safePaths.length === 0) return [];
  const trackedResult = await runGitStatus(repoRoot, [
    "ls-files",
    "-z",
    "--",
    ...safePaths,
  ]);
  if (trackedResult.exitCode !== 0) {
    const details =
      toTrimmedString(trackedResult.stderr) ||
      toTrimmedString(trackedResult.stdout) ||
      `exit code ${trackedResult.exitCode}`;
    throw new Error(`Git command failed (ls-files -z -- <paths>): ${details}`);
  }
  const trackedPaths = parseNulList(trackedResult.stdout);
  if (trackedPaths.length > 0) {
    await runGit(repoRoot, [
      "restore",
      "--staged",
      "--worktree",
      "--",
      ...trackedPaths,
    ]);
  }
  await runGit(repoRoot, ["clean", "-fd", "--", ...safePaths]).catch(
    () => undefined,
  );
  return safePaths;
};

const readCommitSubjectsSince = async (
  repoRoot: string,
  startingHeadCommit: string,
): Promise<string[] | null> => {
  const result = await runGitStatus(repoRoot, [
    "log",
    "--format=%s",
    `${startingHeadCommit}..HEAD`,
  ]);
  if (result.exitCode !== 0) return null;
  return toTrimmedString(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

const readCommitsSince = async (
  repoRoot: string,
  startingHeadCommit: string,
): Promise<Array<{ hash: string; subject: string }> | null> => {
  const result = await runGitStatus(repoRoot, [
    "log",
    "--format=%H%x00%s%x00",
    `${startingHeadCommit}..HEAD`,
  ]);
  if (result.exitCode !== 0) return null;
  const fields = parseNulList(result.stdout);
  const commits: Array<{ hash: string; subject: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const hash = fields[index]?.trim();
    const subject = fields[index + 1]?.trim();
    if (!hash || !subject) continue;
    commits.push({ hash, subject });
  }
  return commits;
};

/**
 * Revert a sequence of commits (newest first) with `git revert`.
 *
 * On a mid-sequence failure the in-flight revert is aborted; with
 * `resetToPreRevertHeadOnFailure` the branch is additionally hard-reset
 * back to the pre-revert HEAD so earlier revert commits in the sequence
 * don't survive as a half-reverted state. Only pass it when the caller
 * has verified the working tree is clean — `reset --hard` discards
 * uncommitted work.
 */
export const revertGitCommits = async (args: {
  repoRoot: string;
  commitHashes: string[];
  resetToPreRevertHeadOnFailure?: boolean;
}): Promise<string[]> => {
  await assertGitRepository(args.repoRoot);
  // Serialize the ref-mutating region per repo (symmetric with
  // commitGitMessage) so an "Undo changes"/rollback firing while another
  // agent commits in the same repo can't race the HEAD ref lock; the
  // ref-lock retry in runGitStatus remains the inner backstop.
  return await withRepoCommitLock(args.repoRoot, () =>
    revertGitCommitsUnlocked(args),
  );
};

/**
 * Ref-mutating revert core. Assumes the caller already holds the per-repo
 * commit lock (`withRepoCommitLock`) — the mutex is NOT reentrant, so internal
 * callers that already took the lock (revertSelfModCommit,
 * rollbackGitChangesSince) MUST call this instead of `revertGitCommits`.
 */
const revertGitCommitsUnlocked = async (args: {
  repoRoot: string;
  commitHashes: string[];
  resetToPreRevertHeadOnFailure?: boolean;
}): Promise<string[]> => {
  const preRevertHead = args.resetToPreRevertHeadOnFailure
    ? await getGitHead(args.repoRoot)
    : null;
  const reverted: string[] = [];
  for (const hash of args.commitHashes) {
    try {
      await runGit(args.repoRoot, ["revert", "--no-edit", hash]);
      reverted.push(hash);
    } catch (error) {
      try {
        await runGit(args.repoRoot, ["revert", "--abort"]);
      } catch {
        // Best effort only.
      }
      if (preRevertHead && reverted.length > 0) {
        await runGit(args.repoRoot, [
          "reset",
          "--hard",
          preRevertHead,
        ]).catch(() => undefined);
      }
      throw error;
    }
  }
  return reverted;
};

/**
 * Revert a single self-mod commit (the inline "Undo changes" flow).
 * `commitHash` defaults to the most recent self-mod commit; `steps`
 * controls how far back from there to revert (defaults to 1).
 *
 * NOTE: `steps > 1` currently throws — the returned
 * `originThreadKey`/`conversationId` are sampled from the first
 * reverted commit only and would mis-route the revert-notice hook
 * across thread boundaries. Lift this guard once a caller wires
 * per-thread fan-out across the range.
 */
export const revertSelfModCommit = async (args: {
  repoRoot: string;
  commitHash?: string | null;
  steps?: number;
}): Promise<SelfModRevertResult> => {
  const { repoRoot } = args;
  await assertGitRepository(repoRoot);

  const startCommit =
    args.commitHash?.trim() ||
    (await getLastSelfModCommitHash(repoRoot)) ||
    "";
  if (!startCommit) {
    throw new Error("No commit found to revert.");
  }

  if (args.commitHash?.trim()) {
    const message = await runGit(repoRoot, [
      "show",
      "-s",
      "--format=%s%n%b",
      startCommit,
    ]);
    if (!isStellaSelfModCommitMessage(message)) {
      throw new Error(
        `Refusing to revert non-Stella self-mod commit "${startCommit}".`,
      );
    }
  }

  const steps = Math.max(1, Math.floor(args.steps ?? 1));
  // Multi-step reverts collapse cross-thread attribution: the
  // `originThreadKey`/`conversationId` returned below are sampled from
  // the FIRST reverted commit only, so the revert-notice hook would
  // mis-route the hidden reminder when reverted commits span multiple
  // agent threads. The only live caller (the inline "Undo changes"
  // affordance) always passes `steps: 1`, so explicitly refuse anything
  // larger until a multi-step caller lands with its own per-thread
  // routing strategy. Safer than relying on prose.
  if (steps > 1) {
    throw new Error(
      `revertSelfModCommit called with steps=${steps}; multi-step reverts collapse Stella-Thread / Stella-Conversation trailer attribution to the first commit and would mis-route the revert-notice reminder. Reduce to steps=1 or extend the caller to fan attribution across the range.`,
    );
  }
  let commitHashes: string[] = [];
  try {
    const output = await runGit(repoRoot, [
      "log",
      `--max-count=${steps}`,
      "--extended-regexp",
      `--grep=${STELLA_COMMIT_GREP_PATTERN}`,
      "--pretty=format:%H",
      startCommit,
    ]);
    commitHashes = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    throw new Error(
      `Could not resolve commit "${startCommit}" for revert: ${(error as Error).message}`,
    );
  }
  if (commitHashes.length === 0) {
    throw new Error(`No commits found for "${startCommit}".`);
  }

  // Read trailer + touched files BEFORE the revert so we still have a
  // clean handle on the original commit's metadata. After `git revert`,
  // a fresh "Revert ..." commit lands at HEAD with its own trailers,
  // so post-revert lookups would attribute the change to the wrong
  // conversation.
  const sourceCommit = commitHashes[0] ?? startCommit;
  let conversationId: string | null = null;
  let originThreadKey: string | null = null;
  let files: string[] = [];
  try {
    const body = await runGit(repoRoot, [
      "show",
      "-s",
      "--format=%B",
      sourceCommit,
    ]);
    const parsed = parseStellaCommitTrailers(body);
    conversationId = parsed.conversationId ?? null;
    originThreadKey = parsed.threadKey ?? null;
  } catch {
    // Trailer parsing must not block the revert itself.
  }
  try {
    const nameOnly = await runGit(repoRoot, [
      "show",
      "--name-only",
      "--no-renames",
      "--pretty=format:",
      sourceCommit,
    ]);
    files = nameOnly
      .split("\n")
      .map((line) => normalizeGitPath(line.trim()))
      .filter(Boolean);
  } catch {
    // File enumeration is best-effort; reminder text just omits the list.
  }

  // Reads above are lock-free (safe); wrap only the ref-mutating revert, and
  // use the unlocked core since we hold the lock here (non-reentrant mutex).
  const reverted = await withRepoCommitLock(repoRoot, () =>
    revertGitCommitsUnlocked({ repoRoot, commitHashes }),
  );

  return {
    commitHash: startCommit,
    revertedCommitHashes: reverted,
    message:
      reverted.length === 1
        ? `Reverted 1 commit (${reverted[0]?.slice(0, 7)}).`
        : `Reverted ${reverted.length} commits.`,
    conversationId,
    originThreadKey,
    files,
  };
};

type RollbackGitChangesSinceArgs = {
  repoRoot: string;
  startingHeadCommit: string;
  changedFiles?: string[];
  isOwnedCommitSubject?: (subject: string) => boolean;
  allowRevertWithLocalChanges?: boolean;
};

export const rollbackGitChangesSince = async (
  args: RollbackGitChangesSinceArgs,
): Promise<GitRollbackSinceResult> => {
  await assertGitRepository(args.repoRoot);
  const startingHeadCommit = args.startingHeadCommit.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(startingHeadCommit)) {
    return {
      status: "skipped",
      reason: "The rollback starting commit is invalid.",
    };
  }
  // Serialize the ref-mutating rollback region per repo (symmetric with
  // commitGitMessage). The mutex is NOT reentrant, so the locked body uses the
  // unlocked revert core; the ref-lock retry stays the inner backstop.
  return await withRepoCommitLock(args.repoRoot, () =>
    rollbackGitChangesSinceLocked(args, startingHeadCommit),
  );
};

const rollbackGitChangesSinceLocked = async (
  args: RollbackGitChangesSinceArgs,
  startingHeadCommit: string,
): Promise<GitRollbackSinceResult> => {
  if (await abortMergeIfNeeded(args.repoRoot)) {
    return {
      status: "rolled-back",
      headCommit: await getGitHead(args.repoRoot),
      restoredFiles: [],
    };
  }

  const currentHead = await getGitHead(args.repoRoot);
  if (currentHead !== startingHeadCommit) {
    const dirtyFiles = await listGitDirtyFiles(args.repoRoot);
    if (dirtyFiles.length > 0) {
      const safePaths = uniqueSafeRepoPaths(args.changedFiles);
      const safePathSet = new Set(safePaths);
      const dirtyFilesAreOwned =
        safePaths.length > 0 &&
        dirtyFiles.every((file) => safePathSet.has(file));
      if (!dirtyFilesAreOwned) {
        if (args.allowRevertWithLocalChanges) {
          const commits = await readCommitsSince(
            args.repoRoot,
            startingHeadCommit,
          );
          if (
            commits &&
            commits.length > 0 &&
            commits.every((commit) =>
              (args.isOwnedCommitSubject ?? (() => false))(commit.subject),
            )
          ) {
            try {
              await revertGitCommitsUnlocked({
                repoRoot: args.repoRoot,
                commitHashes: commits.map((commit) => commit.hash),
              });
              return {
                status: "rolled-back",
                headCommit: await getGitHead(args.repoRoot),
                restoredFiles: [],
              };
            } catch (error) {
              return {
                status: "skipped",
                headCommit: currentHead,
                reason: `Rollback revert failed while preserving local edits: ${(error as Error).message}`,
              };
            }
          }
        }
        return {
          status: "skipped",
          headCommit: currentHead,
          reason:
            "HEAD moved and the working tree has local changes; rollback skipped to avoid discarding edits.",
        };
      }
      await restoreGitPaths(args.repoRoot, safePaths);
    }
    const subjects = await readCommitSubjectsSince(
      args.repoRoot,
      startingHeadCommit,
    );
    if (
      !subjects ||
      subjects.length === 0 ||
      !subjects.every(args.isOwnedCommitSubject ?? (() => false))
    ) {
      return {
        status: "skipped",
        headCommit: currentHead,
        reason:
          "The commits after rollback start do not match the expected ownership policy.",
      };
    }
    await runGit(args.repoRoot, ["reset", "--hard", startingHeadCommit]);
    return {
      status: "rolled-back",
      headCommit: await getGitHead(args.repoRoot),
      restoredFiles: await restoreGitPaths(args.repoRoot, args.changedFiles),
    };
  }

  return {
    status: "rolled-back",
    headCommit: currentHead,
    restoredFiles: await restoreGitPaths(args.repoRoot, args.changedFiles),
  };
};

export const discardGitDirtyFiles = async (
  repoRoot: string,
): Promise<{ discardedFileCount: number; discardedFiles: string[] }> => {
  await assertGitRepository(repoRoot);
  const dirtyFiles = await listGitDirtyFiles(repoRoot);
  if (dirtyFiles.length === 0) {
    return { discardedFileCount: 0, discardedFiles: [] };
  }

  // Serialize the ref/index-mutating discard per repo (symmetric with
  // commitGitMessage); the ref-lock retry stays the inner backstop.
  await withRepoCommitLock(repoRoot, async () => {
    await runGit(repoRoot, ["reset", "--hard", "HEAD"]);
    await runGit(repoRoot, ["clean", "-fd"]);
  });

  return { discardedFileCount: dirtyFiles.length, discardedFiles: dirtyFiles };
};
