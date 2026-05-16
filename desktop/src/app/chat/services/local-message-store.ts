/**
 * Renderer-side client for the messages-window IPC (`listMessages` /
 * `listMessagesBefore`). Mirrors `local-chat-store.ts` (the raw event
 * window store) but consumes the message-shape that already has each
 * assistant turn's tool/agent-completed events pre-grouped on
 * `MessageRecord.toolEvents`.
 *
 * Subscription model: one entry per `(conversationId, maxVisibleMessages)`
 * key. On any `localChat:updated` notification we re-issue `listMessages`
 * for every active entry rather than maintaining an in-memory overlay —
 * the per-turn grouping is server-side now and the query is cheap (cap is
 * a small visible-message count, not a large raw-event count), so a
 * re-fetch per event still beats reimplementing the grouping logic in TS
 * and keeping it in sync with the runtime's writers.
 */
import type {
  LocalChatUpdatedPayload,
  MessageRecord,
} from "../../../../../runtime/contracts/local-chat.js";

const getLocalChatApi = () => {
  const api = window.electronAPI?.localChat;
  if (!api) {
    throw new Error(
      "[local-message-store] Electron local chat API is unavailable.",
    );
  }
  return api;
};

export type LocalMessageWindow = {
  messages: MessageRecord[];
  visibleMessageCount: number;
};

const EMPTY_MESSAGES: MessageRecord[] = [];
const EMPTY_WINDOW: LocalMessageWindow = {
  messages: EMPTY_MESSAGES,
  visibleMessageCount: 0,
};

export const listLocalMessages = async (
  conversationId: string,
  maxVisibleMessages: number,
): Promise<LocalMessageWindow> => {
  const window = await getLocalChatApi().listMessages({
    conversationId,
    maxVisibleMessages,
  });
  return {
    messages: window.messages,
    visibleMessageCount: window.visibleMessageCount,
  };
};

export const listLocalMessagesBefore = async (
  conversationId: string,
  args: {
    beforeTimestampMs: number;
    beforeId: string;
    maxVisibleMessages: number;
  },
): Promise<LocalMessageWindow> => {
  const window = await getLocalChatApi().listMessagesBefore({
    conversationId,
    beforeTimestampMs: args.beforeTimestampMs,
    beforeId: args.beforeId,
    maxVisibleMessages: args.maxVisibleMessages,
  });
  return {
    messages: window.messages,
    visibleMessageCount: window.visibleMessageCount,
  };
};

const subscribeToLocalChatUpdates = (
  listener: (payload: LocalChatUpdatedPayload | null) => void,
): (() => void) => getLocalChatApi().onUpdated(listener);

export type LocalMessageWindowSnapshot = {
  window: LocalMessageWindow;
  hasLoaded: boolean;
  error: Error | null;
};

type LocalMessageWindowOptions = {
  conversationId: string;
  maxVisibleMessages: number;
};

type LocalMessageWindowEntry = LocalMessageWindowOptions & {
  key: string;
  snapshot: LocalMessageWindowSnapshot;
  listeners: Set<(snapshot: LocalMessageWindowSnapshot) => void>;
  loading: Promise<void> | null;
  /**
   * Set to `true` whenever `refreshEntry` is called while a previous
   * refresh is still in flight. The in-flight read may have started
   * before the triggering `localChat:updated` event committed to SQLite,
   * so we run one more refresh in the `.finally` block to make sure the
   * window catches up. Drains in a single tail call — concurrent
   * triggers collapse into one follow-up read instead of stacking.
   */
  pendingRefetch: boolean;
};

const EMPTY_SNAPSHOT: LocalMessageWindowSnapshot = {
  window: EMPTY_WINDOW,
  hasLoaded: false,
  error: null,
};

const localMessageWindows = new Map<string, LocalMessageWindowEntry>();
let unsubscribeLocalChatUpdates: (() => void) | null = null;

const localMessageWindowKey = (options: LocalMessageWindowOptions) =>
  [options.conversationId, options.maxVisibleMessages].join("\n");

const cloneSnapshot = (
  snapshot: LocalMessageWindowSnapshot,
): LocalMessageWindowSnapshot => ({ ...snapshot });

const setSnapshot = (
  entry: LocalMessageWindowEntry,
  snapshot: LocalMessageWindowSnapshot,
) => {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) {
    listener(cloneSnapshot(snapshot));
  }
};

const refreshEntry = (entry: LocalMessageWindowEntry): Promise<void> => {
  if (entry.loading) {
    // Update arrived mid-read. Mark a follow-up so the `.finally` block
    // re-issues the fetch once the current one resolves — otherwise the
    // window can latch onto a snapshot captured strictly before the
    // triggering write.
    entry.pendingRefetch = true;
    return entry.loading;
  }
  entry.pendingRefetch = false;
  entry.loading = listLocalMessages(
    entry.conversationId,
    entry.maxVisibleMessages,
  )
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
  for (const entry of localMessageWindows.values()) {
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
  options: LocalMessageWindowOptions,
): LocalMessageWindowEntry => {
  const key = localMessageWindowKey(options);
  const existing = localMessageWindows.get(key);
  if (existing) return existing;
  const seed = [...localMessageWindows.values()]
    .filter(
      (entry) =>
        entry.conversationId === options.conversationId &&
        entry.snapshot.hasLoaded &&
        entry.maxVisibleMessages < options.maxVisibleMessages,
    )
    .sort((a, b) => b.maxVisibleMessages - a.maxVisibleMessages)[0];
  const entry: LocalMessageWindowEntry = {
    ...options,
    key,
    snapshot: seed
      ? { ...cloneSnapshot(seed.snapshot), hasLoaded: false }
      : EMPTY_SNAPSHOT,
    listeners: new Set(),
    loading: null,
    pendingRefetch: false,
  };
  localMessageWindows.set(key, entry);
  return entry;
};

export const subscribeToLocalMessageWindow = (
  options: LocalMessageWindowOptions,
  listener: (snapshot: LocalMessageWindowSnapshot) => void,
): (() => void) => {
  ensureSubscription();
  const entry = getOrCreateEntry(options);
  entry.listeners.add(listener);
  listener(cloneSnapshot(entry.snapshot));
  void refreshEntry(entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      localMessageWindows.delete(entry.key);
    }
    if (localMessageWindows.size === 0 && unsubscribeLocalChatUpdates) {
      unsubscribeLocalChatUpdates();
      unsubscribeLocalChatUpdates = null;
    }
  };
};

export const __privateLocalMessageStore = {
  handleLocalChatUpdated,
  resetForTests() {
    unsubscribeLocalChatUpdates?.();
    unsubscribeLocalChatUpdates = null;
    localMessageWindows.clear();
  },
};
