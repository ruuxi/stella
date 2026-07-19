/**
 * Per-path serialization for file-mutating tools.
 *
 * When an agent batch issues multiple Edit/Write/apply_patch calls against
 * the same file in parallel, unserialized read-modify-write cycles race:
 * last-write-wins clobbering, lost hunks, and (observed in the wild)
 * NUL-padded tail corruption from interleaved writes. Every tool-level
 * mutation of a file must run its ENTIRE read → apply → write cycle inside
 * `withFileWriteLock` so concurrent edits of the same resolved path execute
 * sequentially. Edits to different paths still run in parallel.
 */

import { promises as fs } from "fs";
import path from "path";

const queues = new Map<string, Promise<void>>();

const lockKeyForPath = (filePath: string): string => {
  const resolved = path.resolve(filePath);
  // File systems on macOS/Windows are typically case-insensitive; normalize
  // so `/Foo.ts` and `/foo.ts` serialize against each other.
  return process.platform === "linux" ? resolved : resolved.toLowerCase();
};

/**
 * Run `fn` with an exclusive async lock on `filePath`. Calls targeting the
 * same resolved path are chained FIFO; other paths are unaffected. The
 * caller's read-modify-write cycle must live entirely inside `fn` — no
 * reading current content before acquiring the lock.
 */
export const withFileWriteLock = async <T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const key = lockKeyForPath(filePath);
  const prev = queues.get(key) ?? Promise.resolve();
  // Run regardless of whether the previous holder succeeded or failed.
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  });
  return run;
};

/**
 * Acquire locks on several paths (e.g. an update that also moves the file).
 * Keys are deduped and acquired in sorted order so two multi-path callers
 * can never deadlock against each other.
 */
export const withFileWriteLocks = async <T>(
  filePaths: string[],
  fn: () => Promise<T>,
): Promise<T> => {
  const keys = [...new Set(filePaths.map(lockKeyForPath))].sort();
  const run = keys.reduceRight<() => Promise<T>>(
    (inner, key) => () => withFileWriteLock(key, inner),
    fn,
  );
  return run();
};

/** Exposed for tests: number of paths with an in-flight lock chain. */
export const pendingFileWriteLockCount = (): number => queues.size;

const containsUnexpectedNul = (written: string, intended: string): boolean =>
  written.includes("\u0000") && !intended.includes("\u0000");

/**
 * Write `content` to `filePath` and verify the bytes on disk read back
 * exactly equal the intended content. Equality is strictly stronger than
 * the original NUL-absence check (the corruption signature seen when
 * parallel edits raced), which is kept only to pick the loud message.
 * Should be unreachable once writes are serialized — retries once and
 * fails loudly if it ever fires. The write itself is in-place: a crash
 * mid-write can leave a truncated file, so callers replacing a file whose
 * current bytes must survive a crash should use
 * {@link writeFileAtomicWithVerify} instead.
 */
export const writeFileWithNulGuard = async (
  filePath: string,
  content: string,
  options?: { flag?: string },
): Promise<void> => {
  const maxAttempts = 2;
  let lastWritten = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      ...(options?.flag && attempt === 1 ? { flag: options.flag } : {}),
    });
    lastWritten = await fs.readFile(filePath, "utf-8");
    if (lastWritten === content) {
      return;
    }
    const kind = containsUnexpectedNul(lastWritten, content)
      ? "NUL-byte corruption"
      : "read-back mismatch";
    console.error(
      `[file-write-lock] ${kind} detected after writing ` +
        `${filePath} (attempt ${attempt}/${maxAttempts}) — this should be ` +
        `impossible with per-path serialization; investigate concurrent ` +
        `writers outside the tool layer.`,
    );
  }
  throw new Error(
    containsUnexpectedNul(lastWritten, content)
      ? `Write verification failed for ${filePath}: file contains NUL bytes ` +
          `that were not part of the intended content, even after a retry. ` +
          `The file may be corrupted by a concurrent writer.`
      : `Write verification failed for ${filePath}: the bytes on disk do ` +
          `not match the intended content, even after a retry. The file ` +
          `may be corrupted by a concurrent writer.`,
  );
};

/**
 * Crash-safe whole-file replacement: write to a same-directory temp file,
 * fsync it, verify its bytes read back exactly equal the intended content,
 * then rename over the target. A crash at any point leaves either the old
 * bytes or the new bytes at `filePath` — never a truncated hybrid, which is
 * what an in-place rewrite risks. The directory entry is not fsynced: losing
 * the rename itself to a crash re-presents the old file, which every caller
 * of a copy-first/replace-after shape tolerates. Callers still own locking;
 * this replaces only the write step. The temp file is removed on failure.
 */
export const writeFileAtomicWithVerify = async (
  filePath: string,
  content: string,
): Promise<void> => {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  try {
    const handle = await fs.open(tmpPath, "wx");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const written = await fs.readFile(tmpPath, "utf-8");
    if (written !== content) {
      throw new Error(
        `Atomic write verification failed for ${filePath}: the temp file's ` +
          `bytes do not match the intended content.`,
      );
    }
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort; an orphaned dot-tmp file is inert
    }
    throw error;
  }
};
