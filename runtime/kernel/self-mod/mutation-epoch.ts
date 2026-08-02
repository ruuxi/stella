import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type QueueSlot = {
  tail: Promise<void>;
};

type FileLease = {
  ticketFile: string;
  token: string;
};

const queueByRepo = new Map<string, QueueSlot>();
const FILE_LOCK_POLL_MS = 50;
const INCOMPLETE_LOCK_STALE_MS = 5_000;

const canonicalRepoKey = async (repoRoot: string): Promise<string> => {
  const resolved = path.resolve(repoRoot);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
};

const lockDirectoryForRepo = (repoKey: string): string => {
  const hash = crypto.createHash("sha256").update(repoKey).digest("hex");
  return path.join(
    os.tmpdir(),
    `stella-self-mod-mutation-${hash.slice(0, 24)}.lock.d`,
  );
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Self-mod mutation epoch acquisition was aborted.");
};

const ownerIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const acquireFileLease = async (
  repoKey: string,
  signal?: AbortSignal,
): Promise<FileLease> => {
  const lockDirectory = lockDirectoryForRepo(repoKey);
  await fs.mkdir(lockDirectory, { recursive: true });
  const token = `${process.pid}:${crypto.randomUUID()}`;
  // Every contender owns a unique ticket path. Stale reclamation therefore
  // only ever removes the observed owner's immutable ticket; it can never
  // unlink a replacement lease installed at a shared path (the classic ABA
  // race of pid-file locks).
  const ticketName = `${String(Date.now()).padStart(13, "0")}-${process.pid}-${crypto.randomUUID()}.ticket`;
  const ticketFile = path.join(lockDirectory, ticketName);
  const handle = await fs.open(ticketFile, "wx");
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
  } finally {
    await handle.close();
  }

  for (;;) {
    try {
      throwIfAborted(signal);
    } catch (error) {
      await fs.unlink(ticketFile).catch(() => undefined);
      throw error;
    }
    try {
      const tickets = (await fs.readdir(lockDirectory))
        .filter((name) => name.endsWith(".ticket"))
        .sort();
      let firstLiveTicket: string | undefined;
      for (const name of tickets) {
        const candidate = path.join(lockDirectory, name);
        try {
          const raw = await fs.readFile(candidate, "utf8");
          const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
          if (
            typeof parsed.pid === "number" &&
            typeof parsed.token === "string" &&
            ownerIsAlive(parsed.pid)
          ) {
            firstLiveTicket = name;
            break;
          }
          // Candidate names are never reused, so deleting this exact stale
          // ticket cannot remove a future owner's lease.
          await fs.unlink(candidate).catch(() => undefined);
        } catch {
          // A just-created ticket can be visible before its JSON write lands.
          // Only reclaim an incomplete unique ticket after the grace window.
          try {
            const stat = await fs.stat(candidate);
            if (Date.now() - stat.mtimeMs <= INCOMPLETE_LOCK_STALE_MS) {
              firstLiveTicket = name;
              break;
            }
            await fs.unlink(candidate).catch(() => undefined);
          } catch {
            continue;
          }
        }
      }
      if (firstLiveTicket === ticketName) {
        return { ticketFile, token };
      }
      // Our ticket can only disappear if an external cleanup raced this
      // acquisition. Recreate it under a fresh immutable name by failing
      // loudly instead of entering the epoch without a durable lease.
      if (!tickets.includes(ticketName)) {
        throw new Error("Self-mod mutation epoch ticket disappeared.");
      }
      await delay(FILE_LOCK_POLL_MS, undefined, { signal }).catch((error) => {
        throwIfAborted(signal);
        throw error;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      await fs.unlink(ticketFile).catch(() => undefined);
      throw error;
    }
  }
};

const releaseFileLease = async (lease: FileLease): Promise<void> => {
  try {
    const parsed = JSON.parse(await fs.readFile(lease.ticketFile, "utf8")) as {
      token?: unknown;
    };
    if (parsed.token !== lease.token) return;
    await fs.unlink(lease.ticketFile).catch(() => undefined);
  } catch {
    // Already reclaimed/removed: there is no lease left for us to release.
  }
};

/**
 * Acquire exclusive mutation ownership for one checkout. The in-process FIFO
 * covers normal concurrent agents; immutable pid/token tickets keep a worker
 * restart from overlapping a still-live predecessor. The lease spans engine
 * execution AND self-mod finalization, so another vanilla engine cannot have
 * its writes swept into this run's Apply commit.
 */
export const acquireRepoMutationEpoch = async (
  repoRoot: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> => {
  const repoKey = await canonicalRepoKey(repoRoot);
  const previous = queueByRepo.get(repoKey)?.tail ?? Promise.resolve();
  let releaseQueue!: () => void;
  const tail = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  queueByRepo.set(repoKey, { tail });
  // Do not let an aborted waiter punch a hole in FIFO ordering: it waits for
  // its predecessor, then exits before taking the cross-process lease.
  await previous;
  try {
    throwIfAborted(signal);
    const fileLease = await acquireFileLease(repoKey, signal);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await releaseFileLease(fileLease);
      } finally {
        releaseQueue();
        if (queueByRepo.get(repoKey)?.tail === tail) {
          queueByRepo.delete(repoKey);
        }
      }
    };
  } catch (error) {
    releaseQueue();
    if (queueByRepo.get(repoKey)?.tail === tail) {
      queueByRepo.delete(repoKey);
    }
    throw error;
  }
};
