import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

const LOCK_STALE_MS = 2 * 60_000;
const LOCK_POLL_MS = 50;

const abortError = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Media artifact materialization was canceled.");
  error.name = "AbortError";
  return error;
};

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export const readyMediaArtifactSize = async (
  filePath: string,
): Promise<number | null> => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0 ? stat.size : null;
  } catch {
    return null;
  }
};

/** Cross-process single-writer, atomic temp+rename materialization. */
export const materializeMediaArtifact = async (args: {
  filePath: string;
  signal?: AbortSignal;
  producer: (signal?: AbortSignal) => Promise<Buffer>;
  producerTimeoutMs?: number;
}): Promise<{ path: string; sizeBytes: number; created: boolean }> => {
  const existing = await readyMediaArtifactSize(args.filePath);
  if (existing !== null) {
    return { path: args.filePath, sizeBytes: existing, created: false };
  }
  const lockPath = `${args.filePath}.lock`;
  let lock: Awaited<ReturnType<typeof fs.open>> | null = null;
  while (!lock) {
    if (args.signal?.aborted) throw abortError(args.signal);
    try {
      lock = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await readyMediaArtifactSize(args.filePath);
      if (raced !== null) {
        return { path: args.filePath, sizeBytes: raced, created: false };
      }
      const lockStat = await fs.stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      await wait(LOCK_POLL_MS, args.signal);
    }
  }

  const partialPath = `${args.filePath}.partial-${process.pid}-${randomUUID()}`;
  const timeoutController = new AbortController();
  const timeout = args.producerTimeoutMs
    ? setTimeout(
        () =>
          timeoutController.abort(
            new Error("Media artifact download timed out."),
          ),
        args.producerTimeoutMs,
      )
    : null;
  const producerSignal = args.signal
    ? AbortSignal.any([args.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    const raced = await readyMediaArtifactSize(args.filePath);
    if (raced !== null) {
      return { path: args.filePath, sizeBytes: raced, created: false };
    }
    const bytes = await args.producer(producerSignal);
    if (producerSignal.aborted) throw abortError(producerSignal);
    if (bytes.length === 0) throw new Error("Media artifact was empty.");
    const output = await fs.open(partialPath, "wx", 0o600);
    try {
      await output.writeFile(bytes);
      await output.sync();
    } finally {
      await output.close();
    }
    await fs.rename(partialPath, args.filePath);
    const sizeBytes = await readyMediaArtifactSize(args.filePath);
    if (sizeBytes === null) {
      throw new Error("Media artifact was not durable after atomic write.");
    }
    return { path: args.filePath, sizeBytes, created: true };
  } finally {
    if (timeout) clearTimeout(timeout);
    await fs.unlink(partialPath).catch(() => undefined);
    await lock.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  }
};
