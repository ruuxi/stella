import { useEffect, useMemo, useState } from "react";
import { useOptionalUiState } from "@/context/ui-state";

type DisplayFileReadResult =
  | {
      bytes: Uint8Array;
      sizeBytes: number;
      mimeType: string;
      missing: false;
    }
  | { missing: true; mimeType: string; path: string };

export type DisplayFileBlob = {
  url: string;
  mimeType: string;
  blob: Blob;
};

const isDisplayFileApiAvailable = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.electronAPI?.display?.readFile === "function";

const readDisplayFileRaw = async (
  filePath: string,
  unavailableMessage?: string,
  conversationId?: string | null,
): Promise<DisplayFileReadResult> => {
  if (!isDisplayFileApiAvailable()) {
    throw new Error(
      unavailableMessage ?? "File preview requires the Electron host runtime.",
    );
  }
  return await window.electronAPI!.display.readFile(filePath, {
    conversationId,
  });
};

/**
 * Refcounted cache for display-file reads.
 *
 * Many sidebar viewers want the same file at the same time — e.g. the
 * Media tab's selected image is consumed by `MediaTile`, `MediaActionBar`,
 * and the hero `MediaPreviewCard` simultaneously. Without a shared
 * cache each consumer would issue its own IPC read, allocate its own
 * `Blob`, and create its own `URL.createObjectURL`, multiplying both
 * IPC traffic and renderer memory. The cache keys on the file path,
 * lazily creates a single in-flight promise, and ref-counts consumers
 * so the underlying blob URL is only revoked once nobody is using it.
 *
 * Entries that drop to zero refs aren't immediately freed — a short
 * grace window lets a re-render that briefly switches consumers (e.g.
 * key change) reuse the same Blob/URL instead of re-reading from disk.
 */

type CacheEntry = {
  promise: Promise<DisplayFileReadResult>;
  /** Resolved value (filled once `promise` settles). */
  resolved: DisplayFileReadResult | null;
  /** Lazily-allocated Blob + objectURL for consumers that want either. */
  blob: Blob | null;
  url: string | null;
  refCount: number;
  /** Pending eviction timer set when refCount drops to zero. */
  evictionTimer: ReturnType<typeof setTimeout> | null;
};

const cache = new Map<string, CacheEntry>();
const CACHE_GRACE_MS = 750;

const blobFromBytes = (entry: CacheEntry): Blob | null => {
  if (entry.blob) return entry.blob;
  const resolved = entry.resolved;
  if (!resolved || resolved.missing) return null;
  // Allocate a fresh `ArrayBuffer` for the Blob so it owns memory
  // independent of any other view derived from `resolved.bytes`.
  const buffer = new ArrayBuffer(resolved.bytes.byteLength);
  new Uint8Array(buffer).set(resolved.bytes);
  const blob = new Blob([buffer], {
    type: resolved.mimeType || "application/octet-stream",
  });
  entry.blob = blob;
  return blob;
};

const objectUrlFor = (entry: CacheEntry): string | null => {
  if (entry.url) return entry.url;
  const blob = blobFromBytes(entry);
  if (!blob) return null;
  entry.url = URL.createObjectURL(blob);
  return entry.url;
};

const finalizeEvict = (filePath: string, entry: CacheEntry) => {
  if (entry.url) {
    URL.revokeObjectURL(entry.url);
    entry.url = null;
  }
  entry.blob = null;
  // Only drop the map slot if it still points at this entry — a retry may
  // have replaced it (e.g. after a rejected/missing read) while stale
  // consumers of the old entry were still winding down their refs.
  if (cache.get(filePath) === entry) cache.delete(filePath);
};

const acquire = (
  filePath: string,
  unavailableMessage: string | undefined,
  conversationId: string | null | undefined,
): CacheEntry => {
  const cacheKey = `${conversationId ?? ""}\0${filePath}`;
  let entry = cache.get(cacheKey);
  if (!entry) {
    const promise = readDisplayFileRaw(
      filePath,
      unavailableMessage,
      conversationId,
    );
    entry = {
      promise,
      resolved: null,
      blob: null,
      url: null,
      refCount: 0,
      evictionTimer: null,
    };
    cache.set(cacheKey, entry);
    void promise
      .then((result) => {
        // Guard against the entry having been evicted while the IPC was
        // in flight (no consumers ever subscribed).
        if (cache.get(cacheKey) !== entry) return;
        if (result.missing) {
          // A missing file may appear on disk moments later, so don't cache
          // the negative result. Drop the entry so the next acquire()
          // re-reads; current awaiters still observe `missing` via the
          // settled promise they already hold.
          cache.delete(cacheKey);
          return;
        }
        entry!.resolved = result;
      })
      .catch(() => {
        // A transient IPC failure must not be cached forever. Drop the entry
        // so the next acquire() retries. Current awaiters still surface the
        // error via the promise they already hold; swallowing here only
        // prevents an unhandled rejection.
        if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
      });
  }
  if (entry.evictionTimer) {
    clearTimeout(entry.evictionTimer);
    entry.evictionTimer = null;
  }
  entry.refCount += 1;
  return entry;
};

const release = (filePath: string, entry: CacheEntry) => {
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount > 0) return;
  if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
  entry.evictionTimer = setTimeout(() => {
    if (entry.refCount === 0) finalizeEvict(filePath, entry);
  }, CACHE_GRACE_MS);
};

/**
 * Read a file's bytes through the cache. The returned promise resolves
 * once the underlying IPC completes; subsequent callers piggyback on
 * the in-flight or already-resolved entry.
 */
export function useDisplayFileBytes(
  filePath: string,
  unavailableMessage?: string,
  conversationIdOverride?: string | null,
) {
  const uiState = useOptionalUiState();
  const conversationId =
    conversationIdOverride !== undefined
      ? conversationIdOverride
      : (uiState?.state.conversationId ?? null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMissing(false);
    setBytes(null);

    const cacheKey = `${conversationId ?? ""}\0${filePath}`;
    const entry = acquire(filePath, unavailableMessage, conversationId);
    void entry.promise
      .then((result) => {
        if (cancelled) return;
        if (result.missing) {
          setMissing(true);
          return;
        }
        setBytes(result.bytes);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      release(cacheKey, entry);
    };
  }, [conversationId, filePath, unavailableMessage]);

  return { bytes, error, loading, missing };
}

export function useDisplayFileBlobs(
  filePaths: string[],
  unavailableMessage?: string,
  conversationIdOverride?: string | null,
) {
  const uiState = useOptionalUiState();
  const conversationId =
    conversationIdOverride !== undefined
      ? conversationIdOverride
      : (uiState?.state.conversationId ?? null);
  const [files, setFiles] = useState<(DisplayFileBlob | null)[]>(() =>
    filePaths.map(() => null),
  );
  const [missing, setMissing] = useState<boolean[]>(() =>
    filePaths.map(() => false),
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // `filePaths` reference changes on every render, so key off contents.
  const key = useMemo(
    () => `${conversationId ?? ""}\0${filePaths.join("|")}`,
    [conversationId, filePaths],
  );

  useEffect(() => {
    let cancelled = false;

    const acquired: { cacheKey: string; entry: CacheEntry }[] = filePaths.map(
      (filePath) => ({
        cacheKey: `${conversationId ?? ""}\0${filePath}`,
        entry: acquire(filePath, unavailableMessage, conversationId),
      }),
    );

    // Synchronous fast-path: when every requested file is already
    // resolved in the cache, seed state directly instead of blanking to
    // null first. Blanking would unmount the consuming media element
    // (e.g. <audio>/<video>/<img>) on every selection change and force a
    // visible remount/flash; seeding keeps it mounted and just swaps src.
    const seeded = acquired.map(({ entry }) => {
      const resolved = entry.resolved;
      if (!resolved) return undefined;
      if (resolved.missing)
        return { blob: null as DisplayFileBlob | null, missing: true };
      const url = objectUrlFor(entry);
      const blob = entry.blob;
      if (!url || !blob) return { blob: null, missing: true };
      return {
        blob: {
          url,
          mimeType: resolved.mimeType || "application/octet-stream",
          blob,
        },
        missing: false,
      };
    });
    if (seeded.every((result) => result !== undefined)) {
      setFiles(seeded.map((result) => result!.blob));
      setMissing(seeded.map((result) => result!.missing));
      setError(null);
      setLoading(false);
    } else {
      setLoading(true);
      setError(null);
      setMissing(filePaths.map(() => false));
      setFiles(filePaths.map(() => null));
    }

    void Promise.all(
      acquired.map(async ({ entry }) => {
        try {
          await entry.promise;
        } catch (caught) {
          if (!cancelled) {
            setError(caught instanceof Error ? caught.message : String(caught));
          }
          return { blob: null as DisplayFileBlob | null, missing: false };
        }
        if (entry.resolved?.missing) {
          return { blob: null, missing: true };
        }
        const url = objectUrlFor(entry);
        const blob = entry.blob;
        if (!url || !blob) return { blob: null, missing: true };
        return {
          blob: {
            url,
            mimeType: entry.resolved?.mimeType ?? "application/octet-stream",
            blob,
          },
          missing: false,
        };
      }),
    ).then((results) => {
      if (cancelled) return;
      setFiles(results.map((r) => r.blob));
      setMissing(results.map((r) => r.missing));
      setLoading(false);
    });

    return () => {
      cancelled = true;
      // Pair each acquire with its release. The cache's eviction grace
      // window lets a quick remount (e.g. parent re-render flicker)
      // reuse the same Blob/URL instead of re-fetching, so consumers
      // don't see broken images during transient unmount/remount.
      for (const { cacheKey, entry } of acquired) release(cacheKey, entry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, unavailableMessage]);

  return { files, error, loading, missing };
}
