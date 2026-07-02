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
 * Write `content` to `filePath` and verify the bytes on disk don't contain
 * NUL bytes that weren't in the intended content (the corruption signature
 * seen when parallel edits raced). Should be unreachable once writes are
 * serialized — retries once and fails loudly if it ever fires.
 */
export const writeFileWithNulGuard = async (
  filePath: string,
  content: string,
  options?: { flag?: string },
): Promise<void> => {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      ...(options?.flag && attempt === 1 ? { flag: options.flag } : {}),
    });
    const written = await fs.readFile(filePath, "utf-8");
    if (!containsUnexpectedNul(written, content)) {
      return;
    }
    console.error(
      `[file-write-lock] NUL-byte corruption detected after writing ` +
        `${filePath} (attempt ${attempt}/${maxAttempts}) — this should be ` +
        `impossible with per-path serialization; investigate concurrent ` +
        `writers outside the tool layer.`,
    );
  }
  throw new Error(
    `Write verification failed for ${filePath}: file contains NUL bytes ` +
      `that were not part of the intended content, even after a retry. ` +
      `The file may be corrupted by a concurrent writer.`,
  );
};
