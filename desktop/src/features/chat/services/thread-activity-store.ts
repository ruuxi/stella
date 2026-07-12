/**
 * Renderer-side client for the authoritative thread-activity IPC
 * (`localChat:listThreadActivity`). One row per background-agent thread,
 * projected straight from the runtime's `runtime_agents` table — the single
 * writer is the LocalAgentManager's `persistTask`, so a row's `status` and
 * `description` are always the runtime's current truth, never a fold over
 * event history.
 *
 * Mirrors `local-activity-store.ts` shape: one entry per conversation,
 * re-fetched on every `localChat:threadActivityUpdated` push with a
 * `pendingRefetch` flag so writes that land mid-read don't get dropped.
 */
import type {
  ThreadActivityRecord,
  ThreadActivityUpdatedPayload,
} from "../../../../../runtime/contracts/local-chat.js";

// Absent outside Electron (plain-browser `bun run dev`): degrade to an
// empty, update-free list instead of erroring.
const getLocalChatApi = () => window.electronAPI?.localChat ?? null;

const EMPTY_RECORDS: ThreadActivityRecord[] = [];

export const listThreadActivity = async (
  conversationId: string,
): Promise<ThreadActivityRecord[]> => {
  const api = getLocalChatApi();
  if (!api?.listThreadActivity) return EMPTY_RECORDS;
  return await api.listThreadActivity({ conversationId });
};

const subscribeToThreadActivityUpdates = (
  listener: (payload: ThreadActivityUpdatedPayload) => void,
): (() => void) =>
  getLocalChatApi()?.onThreadActivityUpdated?.(listener) ?? (() => {});

export type ThreadActivitySnapshot = {
  records: ThreadActivityRecord[];
  hasLoaded: boolean;
  error: Error | null;
};

type ThreadActivityEntry = {
  conversationId: string;
  snapshot: ThreadActivitySnapshot;
  listeners: Set<(snapshot: ThreadActivitySnapshot) => void>;
  loading: Promise<void> | null;
  pendingRefetch: boolean;
};

const EMPTY_SNAPSHOT: ThreadActivitySnapshot = {
  records: EMPTY_RECORDS,
  hasLoaded: false,
  error: null,
};

const entries = new Map<string, ThreadActivityEntry>();
let unsubscribeUpdates: (() => void) | null = null;

const setSnapshot = (
  entry: ThreadActivityEntry,
  snapshot: ThreadActivitySnapshot,
) => {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) {
    listener({ ...snapshot });
  }
};

const refreshEntry = (entry: ThreadActivityEntry): Promise<void> => {
  if (entry.loading) {
    entry.pendingRefetch = true;
    return entry.loading;
  }
  entry.pendingRefetch = false;
  entry.loading = listThreadActivity(entry.conversationId)
    .then((records) => {
      setSnapshot(entry, { records, hasLoaded: true, error: null });
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

const handleThreadActivityUpdated = (payload: ThreadActivityUpdatedPayload) => {
  const entry = entries.get(payload.conversationId);
  if (entry) {
    void refreshEntry(entry);
  }
};

const ensureSubscription = () => {
  if (unsubscribeUpdates) return;
  unsubscribeUpdates = subscribeToThreadActivityUpdates(
    handleThreadActivityUpdated,
  );
};

export const subscribeToThreadActivity = (
  conversationId: string,
  listener: (snapshot: ThreadActivitySnapshot) => void,
): (() => void) => {
  ensureSubscription();
  let entry = entries.get(conversationId);
  if (!entry) {
    entry = {
      conversationId,
      snapshot: EMPTY_SNAPSHOT,
      listeners: new Set(),
      loading: null,
      pendingRefetch: false,
    };
    entries.set(conversationId, entry);
  }
  entry.listeners.add(listener);
  listener({ ...entry.snapshot });
  void refreshEntry(entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      entries.delete(conversationId);
    }
    if (entries.size === 0 && unsubscribeUpdates) {
      unsubscribeUpdates();
      unsubscribeUpdates = null;
    }
  };
};

export const __privateThreadActivityStore = {
  handleThreadActivityUpdated,
  resetForTests() {
    unsubscribeUpdates?.();
    unsubscribeUpdates = null;
    entries.clear();
  },
};
