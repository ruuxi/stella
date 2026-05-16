/**
 * Renderer-side client for the agent-lifecycle activity window IPC
 * (`localChat:listActivity`). Mirrors `local-message-store.ts` shape:
 * one entry per `(conversationId, limit, anchor)` key, re-fetched on every
 * `localChat:updated` notification with a `pendingRefetch` flag so updates
 * that fire mid-read don't get dropped.
 *
 * `latestMessageTimestampMs` rides with every snapshot so the task-
 * extraction logic can apply the stale-schedule auto-completion rule
 * without a second IPC.
 */
import type {
  EventRecord,
  LocalChatUpdatedPayload,
} from "../../../../../runtime/contracts/local-chat.js";

const getLocalChatApi = () => {
  const api = window.electronAPI?.localChat;
  if (!api) {
    throw new Error(
      "[local-activity-store] Electron local chat API is unavailable.",
    );
  }
  return api;
};

export type LocalActivityWindow = {
  activities: EventRecord[];
  latestMessageTimestampMs: number | null;
};

const EMPTY_ACTIVITIES: EventRecord[] = [];
const EMPTY_WINDOW: LocalActivityWindow = {
  activities: EMPTY_ACTIVITIES,
  latestMessageTimestampMs: null,
};

export const listLocalActivity = async (
  conversationId: string,
  args: {
    limit?: number;
    beforeTimestampMs?: number;
    beforeId?: string;
  } = {},
): Promise<LocalActivityWindow> => {
  const window = await getLocalChatApi().listActivity({
    conversationId,
    limit: args.limit,
    beforeTimestampMs: args.beforeTimestampMs,
    beforeId: args.beforeId,
  });
  return {
    activities: window.activities,
    latestMessageTimestampMs: window.latestMessageTimestampMs,
  };
};

const subscribeToLocalChatUpdates = (
  listener: (payload: LocalChatUpdatedPayload | null) => void,
): (() => void) => getLocalChatApi().onUpdated(listener);

export type LocalActivityWindowSnapshot = {
  window: LocalActivityWindow;
  hasLoaded: boolean;
  error: Error | null;
};

type LocalActivityWindowOptions = {
  conversationId: string;
  limit: number;
};

type LocalActivityWindowEntry = LocalActivityWindowOptions & {
  key: string;
  snapshot: LocalActivityWindowSnapshot;
  listeners: Set<(snapshot: LocalActivityWindowSnapshot) => void>;
  loading: Promise<void> | null;
  pendingRefetch: boolean;
};

const EMPTY_SNAPSHOT: LocalActivityWindowSnapshot = {
  window: EMPTY_WINDOW,
  hasLoaded: false,
  error: null,
};

const localActivityWindows = new Map<string, LocalActivityWindowEntry>();
let unsubscribeLocalChatUpdates: (() => void) | null = null;

const localActivityWindowKey = (options: LocalActivityWindowOptions) =>
  [options.conversationId, options.limit].join("\n");

const cloneSnapshot = (
  snapshot: LocalActivityWindowSnapshot,
): LocalActivityWindowSnapshot => ({ ...snapshot });

const setSnapshot = (
  entry: LocalActivityWindowEntry,
  snapshot: LocalActivityWindowSnapshot,
) => {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) {
    listener(cloneSnapshot(snapshot));
  }
};

const refreshEntry = (entry: LocalActivityWindowEntry): Promise<void> => {
  if (entry.loading) {
    entry.pendingRefetch = true;
    return entry.loading;
  }
  entry.pendingRefetch = false;
  entry.loading = listLocalActivity(entry.conversationId, { limit: entry.limit })
    .then((window) => {
      setSnapshot(entry, {
        window,
        hasLoaded: true,
        error: null,
      });
    })
    .catch((error) => {
      setSnapshot(entry, {
        ...entry.snapshot,
        hasLoaded: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    })
    .finally(() => {
      entry.loading = null;
      if (entry.pendingRefetch) {
        entry.pendingRefetch = false;
        void refreshEntry(entry);
      }
    });
  return entry.loading;
};

const handleLocalChatUpdated = (payload: LocalChatUpdatedPayload | null) => {
  for (const entry of localActivityWindows.values()) {
    if (
      payload?.conversationId &&
      payload.conversationId !== entry.conversationId
    ) {
      continue;
    }
    void refreshEntry(entry);
  }
};

const ensureSubscription = () => {
  if (unsubscribeLocalChatUpdates) return;
  unsubscribeLocalChatUpdates = subscribeToLocalChatUpdates(
    handleLocalChatUpdated,
  );
};

const getOrCreateEntry = (
  options: LocalActivityWindowOptions,
): LocalActivityWindowEntry => {
  const key = localActivityWindowKey(options);
  const existing = localActivityWindows.get(key);
  if (existing) return existing;
  // Seed from the largest already-loaded smaller window for the same
  // conversation so growing the limit (e.g. ActivityHistoryDialog
  // 500 → 1000 on `loadOlder`) doesn't briefly empty the visible list
  // while the larger fetch is in flight. Mirrors `local-message-store`.
  // `hasLoaded: false` so consumers still know a fresh fetch is in
  // progress for the new limit.
  const seed = [...localActivityWindows.values()]
    .filter(
      (entry) =>
        entry.conversationId === options.conversationId &&
        entry.snapshot.hasLoaded &&
        entry.limit < options.limit,
    )
    .sort((a, b) => b.limit - a.limit)[0];
  const entry: LocalActivityWindowEntry = {
    ...options,
    key,
    snapshot: seed
      ? { ...cloneSnapshot(seed.snapshot), hasLoaded: false }
      : EMPTY_SNAPSHOT,
    listeners: new Set(),
    loading: null,
    pendingRefetch: false,
  };
  localActivityWindows.set(key, entry);
  return entry;
};

export const subscribeToLocalActivityWindow = (
  options: LocalActivityWindowOptions,
  listener: (snapshot: LocalActivityWindowSnapshot) => void,
): (() => void) => {
  ensureSubscription();
  const entry = getOrCreateEntry(options);
  entry.listeners.add(listener);
  listener(cloneSnapshot(entry.snapshot));
  void refreshEntry(entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      localActivityWindows.delete(entry.key);
    }
    if (localActivityWindows.size === 0 && unsubscribeLocalChatUpdates) {
      unsubscribeLocalChatUpdates();
      unsubscribeLocalChatUpdates = null;
    }
  };
};

export const __privateLocalActivityStore = {
  handleLocalChatUpdated,
  resetForTests() {
    unsubscribeLocalChatUpdates?.();
    unsubscribeLocalChatUpdates = null;
    localActivityWindows.clear();
  },
};
