import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * Tiny module-scope resource cache for IPC/HTTP one-shots.
 *
 * Replaces the recurring `useEffect(fetch on mount)` + `let canceled = false` +
 * module-level `inFlight` Map + `lastSeen` snapshot pattern that several
 * Settings hooks were hand-rolling. Each hook gets:
 *
 *   - request dedup (one in-flight promise per key, shared across consumers)
 *   - configurable stale window (skip refetch within `staleMs`)
 *   - synchronous snapshot reads (so re-mounts don't flash a loading state)
 *   - explicit `set` / `invalidate` for mutations
 *
 * Hooks compose on top via `useResourceStore` (typical case) or by binding
 * `useSyncExternalStore` directly (when the hook needs custom selection).
 */

export type ResourceEntry<T> = {
  data: T | undefined;
  error: Error | null;
  fetchedAt: number;
  isFetching: boolean;
};

export type ResourceStore<K extends string, T> = {
  get(key: K): ResourceEntry<T>;
  ensure(key: K, options?: { force?: boolean }): Promise<T>;
  set(key: K, data: T): void;
  push(key: K, data: T): void;
  invalidate(key: K | "*"): void;
  subscribe(key: K, listener: () => void): () => void;
};

const EMPTY_ENTRY: ResourceEntry<unknown> = {
  data: undefined,
  error: null,
  fetchedAt: 0,
  isFetching: false,
};

export function createResourceStore<K extends string, T>(opts: {
  fetcher: (key: K, context: { force: boolean }) => Promise<T>;
  staleMs?: number;
  accept?: (next: T, current: T) => boolean;
}): ResourceStore<K, T> {
  const entries = new Map<K, ResourceEntry<T>>();
  const inFlight = new Map<K, Promise<T>>();
  const listeners = new Map<K, Set<() => void>>();
  // Per-key generation counter. Bumped by `set`, `invalidate`, and each
  // forced fetch so that an in-flight fetch which started under an older
  // generation drops its result instead of clobbering newer state.
  const generations = new Map<K, number>();

  const getGeneration = (key: K): number => generations.get(key) ?? 0;
  const bumpGeneration = (key: K): number => {
    const next = getGeneration(key) + 1;
    generations.set(key, next);
    return next;
  };

  const getEntry = (key: K): ResourceEntry<T> =>
    entries.get(key) ?? (EMPTY_ENTRY as ResourceEntry<T>);

  const notify = (key: K) => {
    const set = listeners.get(key);
    if (!set) return;
    for (const listener of Array.from(set)) listener();
  };

  const setEntry = (key: K, partial: Partial<ResourceEntry<T>>) => {
    const prev = getEntry(key);
    entries.set(key, { ...prev, ...partial });
    notify(key);
  };

  const isFresh = (entry: ResourceEntry<T>): boolean => {
    if (entry.data === undefined) return false;
    if (opts.staleMs === undefined) return true;
    return Date.now() - entry.fetchedAt < opts.staleMs;
  };

  const shouldAccept = (next: T, current: T | undefined): boolean =>
    current === undefined || opts.accept === undefined || opts.accept(next, current);

  const ensure: ResourceStore<K, T>["ensure"] = (key, options) => {
    const entry = getEntry(key);
    if (!options?.force && isFresh(entry)) {
      return Promise.resolve(entry.data as T);
    }
    const existing = inFlight.get(key);
    if (existing && !options?.force) return existing;

    // A forced fetch supersedes any older in-flight fetch (and any value
    // written by `set`/`invalidate`); capture the generation this fetch
    // owns so late-settling stale fetches can be dropped below.
    const generation = options?.force ? bumpGeneration(key) : getGeneration(key);

    setEntry(key, { isFetching: true });
    const promise = (async () => {
      try {
        const data = await opts.fetcher(key, {
          force: options?.force === true,
        });
        if (getGeneration(key) === generation) {
          const current = getEntry(key).data;
          setEntry(
            key,
            shouldAccept(data, current)
              ? {
                  data,
                  error: null,
                  fetchedAt: Date.now(),
                  isFetching: false,
                }
              : { error: null, isFetching: false },
          );
        }
        return data;
      } catch (caught) {
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        if (getGeneration(key) === generation) {
          setEntry(key, { error, isFetching: false });
        }
        throw error;
      }
    })();
    inFlight.set(key, promise);
    // Clear only our own registration once settled — a newer forced fetch may
    // have already replaced it. Attached after assignment so the closure can
    // reference `promise`; the derived promise is caught so a rejected fetch
    // cannot surface as an unhandled rejection here (callers await `promise`).
    void promise
      .finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      })
      .catch(() => undefined);
    return promise;
  };

  return {
    get: getEntry,
    ensure,
    set(key, data) {
      // Supersede any in-flight fetch so its late result can't clobber
      // this just-written value.
      bumpGeneration(key);
      setEntry(key, {
        data,
        error: null,
        fetchedAt: Date.now(),
        isFetching: false,
      });
    },
    push(key, data) {
      const current = getEntry(key).data;
      if (!shouldAccept(data, current)) return;
      // External updates do not supersede an in-flight fetch. The fetch's
      // eventual response is compared against this value before it commits.
      setEntry(key, {
        data,
        error: null,
        fetchedAt: Date.now(),
      });
    },
    invalidate(key) {
      if (key === "*") {
        const keys = new Set<K>([
          ...entries.keys(),
          ...inFlight.keys(),
          ...generations.keys(),
        ]);
        entries.clear();
        for (const k of keys) {
          bumpGeneration(k);
          notify(k);
        }
        return;
      }
      bumpGeneration(key);
      entries.delete(key);
      notify(key);
    },
    subscribe(key, listener) {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        const live = listeners.get(key);
        if (!live) return;
        live.delete(listener);
        if (live.size === 0) listeners.delete(key);
      };
    },
  };
}

/**
 * Subscribe to a key on a `ResourceStore`. Triggers `ensure` on first mount
 * (and on key change) and re-renders when the entry changes. Pass `null` for
 * `key` to skip the subscription (mirrors Convex's `"skip"` sentinel).
 */
export function useResourceStore<K extends string, T>(
  store: ResourceStore<K, T>,
  key: K | null,
): {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
  refresh: () => Promise<T | undefined>;
} {
  const subscribe = useCallback(
    (listener: () => void) =>
      key === null ? () => {} : store.subscribe(key, listener),
    [key, store],
  );
  const getSnapshot = useCallback(
    () =>
      key === null
        ? (EMPTY_ENTRY as ResourceEntry<T>)
        : store.get(key),
    [key, store],
  );
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (key === null) return;
    void store.ensure(key).catch(() => {
      /* error captured on entry */
    });
  }, [key, store]);

  const refresh = useCallback(async () => {
    if (key === null) return undefined;
    try {
      return await store.ensure(key, { force: true });
    } catch {
      return undefined;
    }
  }, [key, store]);

  return {
    data: entry.data,
    error: entry.error,
    isLoading: entry.data === undefined && entry.error === null,
    isFetching: entry.isFetching,
    refresh,
  };
}
