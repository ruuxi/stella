/**
 * Small atomic read-modify-write helper for JSON state files
 * (connector connect-preferences, reminder-window state, …).
 *
 * Guarantees:
 *  - per-file serialization within this process: concurrent updates are
 *    queued, and every update re-reads the file before applying, so no
 *    same-process writer can clobber another's change;
 *  - atomic replace on disk: writes go to a temp file in the same
 *    directory and are renamed into place, so readers (including other
 *    processes) never observe a torn/partial file.
 *
 * Cross-process writers can still interleave whole updates (last rename
 * wins) — acceptable for these low-frequency preference files — but a
 * write can no longer corrupt the file or land mid-read.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const updateQueues = new Map<string, Promise<unknown>>();

const readRaw = async (filePath: string): Promise<unknown> => {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
  } catch {
    // Missing or corrupt file: callers normalize `undefined` to their
    // empty state.
    return undefined;
  }
};

const writeAtomic = async (filePath: string, contents: string) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tempPath, contents, "utf-8");
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

/** Read + normalize a JSON state file without updating it. */
export const readJsonStateFile = async <T>(
  filePath: string,
  parse: (raw: unknown) => T,
): Promise<T> => parse(await readRaw(filePath));

/**
 * Serialized atomic update. `parse` normalizes the freshly re-read raw
 * JSON (or `undefined`) into typed state; `update` mutates it in place
 * or returns a replacement. Resolves with the state that was written.
 */
export const updateJsonStateFile = async <T>(args: {
  filePath: string;
  parse: (raw: unknown) => T;
  update: (state: T) => T | void | Promise<T | void>;
}): Promise<T> => {
  const key = path.resolve(args.filePath);
  const previous = updateQueues.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined) // a failed predecessor must not poison the queue
    .then(async () => {
      const state = args.parse(await readRaw(args.filePath));
      const next = (await args.update(state)) ?? state;
      await writeAtomic(args.filePath, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  updateQueues.set(key, run);
  void run.finally(() => {
    if (updateQueues.get(key) === run) updateQueues.delete(key);
  });
  return await run;
};
