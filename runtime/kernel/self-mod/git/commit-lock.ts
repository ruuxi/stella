import {
  closeSync,
  mkdirSync,
  openSync,
  promises as fsPromises,
  realpathSync,
  writeFileSync,
} from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Cross-agent commit serialization for a single git repo.
 *
 * All Stella agents share ONE runtime worker process: the host launches a
 * single detached worker per Stella root and the worker lifecycle lock
 * guarantees uniqueness, so every concurrent agent run (orchestrator,
 * subagents, multiple conversations, store/source imports) executes inside
 * that one Node process. Concurrent "agent commits" are therefore concurrent
 * async calls into `commitGitMessage` — two `git commit` subprocesses racing
 * the same repo collide on the HEAD ref lock and one aborts with:
 *
 *   fatal: cannot lock ref 'HEAD': is at <sha> but expected <sha>
 *
 * `withRepoCommitLock` serializes the ref-updating region per repo so commits
 * queue instead of racing:
 *
 *   1. An in-process async mutex (one FIFO promise chain per canonical repo
 *      path) queues same-process callers — the reported failure mode. This is
 *      the primary fix; because all agents share the worker process it fully
 *      closes the race on its own.
 *   2. A best-effort cross-process advisory file lock (flock-style
 *      `open(…, "wx")` with pid-based stale reclaim) additionally covers the
 *      rare case of a second process touching the same repo — e.g. a worker
 *      restart overlapping an in-flight finalize, or a transient helper. If it
 *      can't be taken within the budget we proceed anyway and lean on the
 *      ref-lock retry (see `exec.ts`) rather than failing the agent's task.
 *
 * The ref-lock retry-with-backoff in `runGitStatus` sits underneath this as a
 * safety net, so any lock gap — or an external `git` the file lock cannot
 * see — self-heals instead of aborting.
 */

/** In-process FIFO queue tail per canonical repo path. */
const repoQueueTails = new Map<string, Promise<void>>();

const canonicalRepoKey = (repoRoot: string): string => {
  const resolved = path.resolve(repoRoot);
  try {
    // Collapse symlinks / worktree aliases so two spellings of the same repo
    // share one queue and one lock file.
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};

// The cross-process advisory lock is only a best-effort backstop for the rare
// second process touching the same repo; the in-process FIFO mutex already
// serializes same-process callers (the reported failure mode). This budget is
// awaited while HOLDING the FIFO slot, so keep it short to avoid head-of-line
// blocking every queued same-process commit — if we can't take it quickly we
// proceed unlocked and lean on the ref-lock retry in exec.ts.
const FILE_LOCK_TIMEOUT_MS = 400;
const FILE_LOCK_POLL_MS = 40;

type FileLockHandle = { fd: number; lockFile: string };

const lockFilePathFor = (repoKey: string): string => {
  const hash = crypto.createHash("sha1").update(repoKey).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `stella-git-commit-${hash}.lock`);
};

/**
 * Best-effort cross-process advisory lock. Returns a handle to release, or
 * `null` if the lock could not be taken within the budget (in which case the
 * caller proceeds unlocked and relies on the ref-lock retry). The in-process
 * mutex already serializes same-process callers, so contention here is only
 * ever cross-process.
 */
const acquireCrossProcessLock = async (
  repoKey: string,
): Promise<FileLockHandle | null> => {
  const lockFile = lockFilePathFor(repoKey);
  try {
    mkdirSync(path.dirname(lockFile), { recursive: true });
  } catch {
    // If the lock dir can't be created, skip the cross-process lock entirely.
    return null;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < FILE_LOCK_TIMEOUT_MS) {
    try {
      const fd = openSync(lockFile, "wx");
      try {
        writeFileSync(fd, String(process.pid), "utf-8");
      } catch {
        // Non-fatal: the exclusive create already established ownership.
      }
      return { fd, lockFile };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // Unexpected FS error — don't wedge the commit on the advisory lock.
        return null;
      }
      await delay(FILE_LOCK_POLL_MS);
      // Sweep the lock if its holder is gone.
      try {
        const raw = await fsPromises.readFile(lockFile, "utf-8");
        const pid = Number.parseInt(raw.trim(), 10);
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            // Holder is alive — keep waiting.
          } catch {
            // Holder is dead — reclaim.
            await fsPromises.unlink(lockFile).catch(() => undefined);
          }
        } else {
          await fsPromises.unlink(lockFile).catch(() => undefined);
        }
      } catch {
        // Lock vanished under us; loop and retry the create.
      }
    }
  }
  // Timed out — proceed unlocked; the ref-lock retry is the safety net.
  return null;
};

const releaseCrossProcessLock = async (
  handle: FileLockHandle,
): Promise<void> => {
  try {
    closeSync(handle.fd);
  } catch {
    // Ignore close errors during release.
  }
  // Only remove the lock file if we still own it. If our budget elapsed on the
  // acquire side and another process stale-reclaimed the lock (rewriting the
  // pid), unconditionally unlinking here would delete THEIR live lock. Re-read
  // the pid and bail unless it's still ours.
  try {
    const raw = await fsPromises.readFile(handle.lockFile, "utf-8");
    if (Number.parseInt(raw.trim(), 10) !== process.pid) {
      return;
    }
  } catch {
    // Lock file already gone (or unreadable) — nothing to release.
    return;
  }
  await fsPromises.unlink(handle.lockFile).catch(() => undefined);
};

/**
 * Run `fn` while holding the per-repo commit lock. Callers targeting the same
 * repo queue in FIFO order; callers on different repos run concurrently.
 *
 * The mutex is NOT reentrant — never call `withRepoCommitLock` for the same
 * repo from within `fn` or it will deadlock.
 */
export const withRepoCommitLock = async <T>(
  repoRoot: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const key = canonicalRepoKey(repoRoot);
  const previous = repoQueueTails.get(key) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const thisTurn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  // Claim our slot before awaiting the previous holder so ordering is FIFO.
  repoQueueTails.set(key, thisTurn);
  await previous;

  let fileLock: FileLockHandle | null = null;
  try {
    fileLock = await acquireCrossProcessLock(key);
    return await fn();
  } finally {
    if (fileLock) {
      await releaseCrossProcessLock(fileLock);
    }
    releaseTurn();
    // Drop the map entry if nobody queued behind us, so the map doesn't grow
    // unbounded across many repos over the worker's lifetime.
    if (repoQueueTails.get(key) === thisTurn) {
      repoQueueTails.delete(key);
    }
  }
};
