/**
 * Renderer-side client for the messages-window IPC (`listMessages` /
 * `listMessagesBefore`). Mirrors `local-chat-store.ts` (the raw event
 * window store) but consumes the message-shape that already has each
 * assistant turn's tool/agent-completed events pre-grouped on
 * `MessageRecord.toolEvents`.
 *
 * Subscription model: one entry per `(conversationId, maxVisibleMessages)`
 * key. On a `localChat:updated` notification each active entry refreshes
 * in one of two modes (see `RefreshMode`): a tail-only `listMessagesAfter`
 * read from the window's newest row when the update is attributable to a
 * strictly-newer event, or a full `listMessages` re-read otherwise. The
 * per-turn grouping stays server-side either way — the renderer merge
 * only replaces/appends whole `MessageRecord` rows and never re-derives
 * tool-event grouping in TS.
 */
import type {
  LocalChatUpdatedPayload,
  MessageRecord,
} from "../../../../../runtime/contracts/local-chat.js";
import { isUiHiddenChatMessagePayload } from "../../../../../runtime/chat-event-visibility.js";

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

const listLocalMessagesAfter = async (
  conversationId: string,
  args: {
    afterTimestampMs: number;
    afterId: string;
    maxVisibleMessages: number;
  },
): Promise<LocalMessageWindow> => {
  const window = await getLocalChatApi().listMessagesAfter({
    conversationId,
    afterTimestampMs: args.afterTimestampMs,
    afterId: args.afterId,
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

/**
 * How a refresh reads the window:
 *
 *   - `"full"` — re-issue `listMessages` for the whole window. Used for
 *     the initial load, updates we can't attribute to a strictly-newer
 *     event (payload patches like `selfModApplied`, channel edits,
 *     no-payload social notifications), and every fallback path.
 *
 *   - `"tail"` — `listMessagesAfter` from the window's newest row. The
 *     older prefix is immutable (new tool events only ever attach to
 *     anchors in the current turn), so per-event streaming cost stays
 *     proportional to what changed instead of re-serializing the entire
 *     loaded window — the whole-window refetch is what made a deep
 *     `loadOlder` window expensive for the rest of the session.
 */
type RefreshMode = "full" | "tail";

type LocalMessageWindowEntry = LocalMessageWindowOptions & {
  key: string;
  snapshot: LocalMessageWindowSnapshot;
  listeners: Set<(snapshot: LocalMessageWindowSnapshot) => void>;
  loading: Promise<void> | null;
  /**
   * Set whenever `refreshEntry` is called while a previous refresh is
   * still in flight. The in-flight read may have started before the
   * triggering `localChat:updated` event committed to SQLite, so we run
   * one more refresh in the `.finally` block to make sure the window
   * catches up. Drains in a single tail call — concurrent triggers
   * collapse into one follow-up read, escalating to `"full"` when any
   * queued trigger required it.
   */
  pendingRefetch: RefreshMode | null;
};

const EMPTY_SNAPSHOT: LocalMessageWindowSnapshot = {
  window: EMPTY_WINDOW,
  hasLoaded: false,
  error: null,
};

const localMessageWindows = new Map<string, LocalMessageWindowEntry>();

/**
 * Last successfully-loaded window per conversation, bridging the entry
 * teardown→setup gap. Growing the window (`loadOlder`) bumps
 * `maxVisibleMessages`, which re-keys the subscription: React tears down
 * the smaller-window entry (deleting it from `localMessageWindows`)
 * *before* the larger one subscribes, so a live-entry seed lookup finds
 * nothing and the new window would emit an empty snapshot for a frame.
 * That empty flash makes the virtualized list treat the next non-empty
 * render as a fresh mount (re-running its initial scroll-to-end), which
 * throws away the user's scroll position when loading older history.
 * Seeding from this cache keeps the prior messages on screen until the
 * larger window resolves.
 *
 * Lifecycle: while a conversation has live entries the cached value is
 * the same object as the live snapshot's window (no extra memory). Once
 * the last subscription for a conversation unsubscribes, the cache entry
 * is evicted on the next microtask — React's cleanup-before-setup re-key
 * happens synchronously within one commit, so the bridge case is still
 * covered, while navigating away genuinely frees the window instead of
 * pinning every visited conversation's history for the session.
 */
const lastLoadedWindowByConversation = new Map<string, LocalMessageWindow>();

const scheduleSeedCacheEviction = (conversationId: string) => {
  queueMicrotask(() => {
    for (const entry of localMessageWindows.values()) {
      if (entry.conversationId === conversationId) return;
    }
    lastLoadedWindowByConversation.delete(conversationId);
  });
};
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
  if (snapshot.hasLoaded && !snapshot.error) {
    lastLoadedWindowByConversation.set(entry.conversationId, snapshot.window);
  }
  for (const listener of entry.listeners) {
    listener(cloneSnapshot(snapshot));
  }
};

/** Mirrors the store's `compareTimelineCursor` `(timestamp, id)` ordering. */
const compareMessageOrder = (
  a: { timestamp: number; _id: string },
  b: { timestamp: number; _id: string },
): number => {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a._id.localeCompare(b._id);
};

/**
 * Per-tail-refresh cap on changed/new visible rows. Updates are
 * notification-per-event, so a single tick rarely carries more than a few
 * rows; hitting this cap means `listMessagesAfter` may have truncated its
 * result (`limitChangedMessageWindow` stops at the cap) and the caller
 * must fall back to a full refetch rather than merge a partial set.
 */
const TAIL_REFRESH_MAX_VISIBLE = 200;

/**
 * A tail refresh is only sound when the triggering event is strictly
 * newer than the window's newest row. Everything else — payload patches
 * onto existing rows (`selfModApplied`, channel edits/reactions, whose
 * `(timestamp, id)` stays at-or-before the cursor and is therefore
 * invisible to the after-cursor walk), no-payload notifications, unloaded
 * or empty windows — takes the full path.
 */
const resolveRefreshMode = (
  entry: LocalMessageWindowEntry,
  payload: LocalChatUpdatedPayload | null,
): RefreshMode => {
  if (!payload?.conversationId || !payload.event) return "full";
  if (payload.conversationId !== entry.conversationId) return "full";
  const { snapshot } = entry;
  if (!snapshot.hasLoaded || snapshot.error) return "full";
  const newest = snapshot.window.messages.at(-1);
  if (!newest) return "full";
  return compareMessageOrder(payload.event, newest) > 0 ? "tail" : "full";
};

/**
 * Merge a changed-rows result into the current window: rows already in
 * the window are replaced in place (the store returns turn anchors with
 * their *complete* `toolEvents`, not deltas), strictly-newer rows append
 * in order. Changed rows older than the cursor that aren't in the window
 * were trimmed out of it and are skipped.
 */
const mergeChangedMessages = (
  window: LocalMessageWindow,
  cursor: { timestamp: number; _id: string },
  changed: LocalMessageWindow,
): LocalMessageWindow => {
  const indexById = new Map(
    window.messages.map((message, index) => [message._id, index]),
  );
  const next = window.messages.slice();
  const appends: MessageRecord[] = [];
  let visibleMessageCount = window.visibleMessageCount;
  for (const message of changed.messages) {
    const index = indexById.get(message._id);
    if (index !== undefined) {
      const wasHidden = isUiHiddenChatMessagePayload(
        next[index].payload ?? null,
      );
      const isHidden = isUiHiddenChatMessagePayload(message.payload ?? null);
      if (wasHidden !== isHidden) visibleMessageCount += isHidden ? -1 : 1;
      next[index] = message;
      continue;
    }
    if (compareMessageOrder(message, cursor) <= 0) continue;
    appends.push(message);
    if (!isUiHiddenChatMessagePayload(message.payload ?? null)) {
      visibleMessageCount += 1;
    }
  }
  return {
    messages: appends.length > 0 ? [...next, ...appends] : next,
    visibleMessageCount,
  };
};

/**
 * Drop the oldest rows once tail appends push the window past its
 * visible-message cap — the sliding-window behavior a full refetch always
 * had. The trimmed window starts at a visible row, matching the store's
 * cutoff shape.
 */
const trimWindowToVisibleCap = (
  window: LocalMessageWindow,
  maxVisibleMessages: number,
): LocalMessageWindow => {
  if (window.visibleMessageCount <= maxVisibleMessages) return window;
  let visible = 0;
  let start = 0;
  for (let i = window.messages.length - 1; i >= 0; i--) {
    if (!isUiHiddenChatMessagePayload(window.messages[i].payload ?? null)) {
      visible += 1;
      if (visible === maxVisibleMessages) {
        start = i;
        break;
      }
    }
  }
  return {
    messages: window.messages.slice(start),
    visibleMessageCount: visible,
  };
};

const fullRefresh = async (entry: LocalMessageWindowEntry): Promise<void> => {
  const window = await listLocalMessages(
    entry.conversationId,
    entry.maxVisibleMessages,
  );
  setSnapshot(entry, { window, hasLoaded: true, error: null });
};

const tailRefresh = async (entry: LocalMessageWindowEntry): Promise<void> => {
  const { window } = entry.snapshot;
  const cursor = window.messages[window.messages.length - 1];
  if (!cursor) {
    return await fullRefresh(entry);
  }
  const changed = await listLocalMessagesAfter(entry.conversationId, {
    afterTimestampMs: cursor.timestamp,
    afterId: cursor._id,
    maxVisibleMessages: TAIL_REFRESH_MAX_VISIBLE,
  });
  if (changed.visibleMessageCount >= TAIL_REFRESH_MAX_VISIBLE) {
    // The changed set saturated the cap and may be truncated.
    return await fullRefresh(entry);
  }
  if (changed.messages.length === 0) {
    // Nothing in the timeline projection changed (e.g. an agent
    // lifecycle event) — skip the emit so listeners don't re-render.
    return;
  }
  const merged = trimWindowToVisibleCap(
    mergeChangedMessages(entry.snapshot.window, cursor, changed),
    entry.maxVisibleMessages,
  );
  setSnapshot(entry, { window: merged, hasLoaded: true, error: null });
};

const refreshEntry = (
  entry: LocalMessageWindowEntry,
  mode: RefreshMode = "full",
): Promise<void> => {
  if (entry.loading) {
    // Update arrived mid-read. Mark a follow-up so the `.finally` block
    // re-issues the fetch once the current one resolves — otherwise the
    // window can latch onto a snapshot captured strictly before the
    // triggering write. `"full"` wins when triggers of both modes queue.
    entry.pendingRefetch =
      entry.pendingRefetch === "full" || mode === "full" ? "full" : "tail";
    return entry.loading;
  }
  entry.pendingRefetch = null;
  entry.loading = (mode === "tail" ? tailRefresh(entry) : fullRefresh(entry))
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
        const pendingMode = entry.pendingRefetch;
        entry.pendingRefetch = null;
        void refreshEntry(entry, pendingMode);
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
    void refreshEntry(entry, resolveRefreshMode(entry, payload));
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
  // Fall back to the retained last-loaded window when no live smaller-
  // window entry survives (the common `loadOlder` teardown-before-setup
  // case). `hasLoaded: false` keeps `isLoadingOlder` accurate until the
  // larger window resolves, while showing the prior messages avoids the
  // empty-flash → list-remount → scroll-reset. A cached window *larger*
  // than the request (a second surface opening a conversation another
  // surface has scrolled deep) is sliced to the newest `maxVisibleMessages`
  // so the seed never renders more rows than the subscription asked for.
  const cachedWindow = lastLoadedWindowByConversation.get(
    options.conversationId,
  );
  const seedWindow =
    cachedWindow && cachedWindow.messages.length > options.maxVisibleMessages
      ? {
          messages: cachedWindow.messages.slice(-options.maxVisibleMessages),
          visibleMessageCount: Math.min(
            cachedWindow.visibleMessageCount,
            options.maxVisibleMessages,
          ),
        }
      : cachedWindow;
  const seedSnapshot: LocalMessageWindowSnapshot | null = seed
    ? { ...cloneSnapshot(seed.snapshot), hasLoaded: false }
    : seedWindow
      ? { window: seedWindow, hasLoaded: false, error: null }
      : null;
  const entry: LocalMessageWindowEntry = {
    ...options,
    key,
    snapshot: seedSnapshot ?? EMPTY_SNAPSHOT,
    listeners: new Set(),
    loading: null,
    pendingRefetch: null,
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
      scheduleSeedCacheEviction(entry.conversationId);
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
    lastLoadedWindowByConversation.clear();
  },
};
