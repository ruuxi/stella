import { type EventRecord } from "@/app/chat/lib/event-transforms";
import type { LocalChatUpdatedPayload } from "../../../../../runtime/contracts/local-chat.js";
import {
  countVisibleChatMessageEvents,
  sliceEventsByVisibleMessageWindow,
  type LocalChatEventWindowMode,
} from "../../../../../runtime/chat-event-visibility.js";

const getLocalChatApi = () => {
  const api = window.electronAPI?.localChat;
  if (!api) {
    throw new Error(
      "[local-chat-store] Electron local chat API is unavailable.",
    );
  }
  return api;
};

export const getOrCreateLocalConversationId = async (): Promise<string> =>
  getLocalChatApi().getOrCreateDefaultConversationId();

export const listLocalEvents = async (
  conversationId: string,
  maxItems = 200,
  options?: {
    windowBy?: LocalChatEventWindowMode;
  },
): Promise<EventRecord[]> =>
  getLocalChatApi().listEvents({
    conversationId,
    maxItems,
    ...(options?.windowBy ? { windowBy: options.windowBy } : {}),
  });

export const getLocalEventCount = async (
  conversationId: string,
  options?: {
    countBy?: LocalChatEventWindowMode;
  },
): Promise<number> =>
  getLocalChatApi().getEventCount({
    conversationId,
    ...(options?.countBy ? { countBy: options.countBy } : {}),
  });

export const subscribeToLocalChatUpdates = (
  listener: (payload: LocalChatUpdatedPayload | null) => void,
): (() => void) => getLocalChatApi().onUpdated(listener);

export type LocalConversationEventSnapshot = {
  events: EventRecord[];
  count: number;
  hasLoaded: boolean;
  error: Error | null;
};

type LocalConversationEventWindowOptions = {
  conversationId: string;
  maxItems: number;
  windowBy?: LocalChatEventWindowMode;
};

type LocalConversationEventWindowEntry = LocalConversationEventWindowOptions & {
  key: string;
  snapshot: LocalConversationEventSnapshot;
  listeners: Set<(snapshot: LocalConversationEventSnapshot) => void>;
  liveEvents: Map<string, EventRecord>;
  loading: Promise<void> | null;
};

const EMPTY_EVENTS: EventRecord[] = [];

const localEventWindows = new Map<string, LocalConversationEventWindowEntry>();
let unsubscribeLocalChatUpdates: (() => void) | null = null;

const localEventWindowKey = (options: LocalConversationEventWindowOptions) =>
  [options.conversationId, options.maxItems, options.windowBy ?? "events"].join(
    "\n",
  );

const cloneSnapshot = (
  snapshot: LocalConversationEventSnapshot,
): LocalConversationEventSnapshot => ({
  ...snapshot,
});

const sortEvents = (events: EventRecord[]): EventRecord[] =>
  [...events].sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    return a._id.localeCompare(b._id);
  });

const mergeEventSources = (
  primaryEvents: EventRecord[],
  secondaryEvents: EventRecord[],
): EventRecord[] => {
  if (secondaryEvents.length === 0) {
    return primaryEvents;
  }

  const merged = new Map<string, EventRecord>();
  for (const event of primaryEvents) {
    merged.set(event._id, event);
  }
  for (const event of secondaryEvents) {
    merged.set(event._id, event);
  }

  return sortEvents([...merged.values()]);
};

const compareEventOrder = (left: EventRecord, right: EventRecord): number => {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  return left._id.localeCompare(right._id);
};

const isEventAfterPersistedWindow = (
  event: EventRecord,
  persistedEvents: EventRecord[],
): boolean => {
  const latestPersistedEvent = persistedEvents.at(-1);
  if (!latestPersistedEvent) {
    return true;
  }
  return compareEventOrder(event, latestPersistedEvent) > 0;
};

const capEventsForWindow = (
  events: EventRecord[],
  options: LocalConversationEventWindowOptions,
): EventRecord[] => {
  if (options.windowBy === "visible_messages") {
    return sliceEventsByVisibleMessageWindow(
      events,
      options.maxItems,
    ) as EventRecord[];
  }
  if (events.length <= options.maxItems) {
    return events;
  }
  return events.slice(events.length - options.maxItems);
};

const setLocalEventWindowSnapshot = (
  entry: LocalConversationEventWindowEntry,
  snapshot: LocalConversationEventSnapshot,
) => {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) {
    listener(cloneSnapshot(snapshot));
  }
};

const refreshLocalEventWindow = (
  entry: LocalConversationEventWindowEntry,
): Promise<void> => {
  if (entry.loading) {
    return entry.loading;
  }

  entry.loading = Promise.all([
    listLocalEvents(entry.conversationId, entry.maxItems, {
      windowBy: entry.windowBy,
    }),
    getLocalEventCount(entry.conversationId, {
      countBy: entry.windowBy,
    }),
  ])
    .then(([events, count]) => {
      const liveEvents = [...entry.liveEvents.values()];
      const merged = capEventsForWindow(
        mergeEventSources(events, liveEvents),
        entry,
      );
      const persistedEventIds = new Set(events.map((event) => event._id));
      const missingLiveCount = liveEvents
        .filter(
          (event) =>
            !persistedEventIds.has(event._id) &&
            isEventAfterPersistedWindow(event, events),
        )
        .reduce(
          (total, event) => total + countVisibleChatMessageEvents([event]),
          0,
        );
      for (const event of liveEvents) {
        if (
          persistedEventIds.has(event._id) ||
          !isEventAfterPersistedWindow(event, events)
        ) {
          entry.liveEvents.delete(event._id);
        }
      }
      setLocalEventWindowSnapshot(entry, {
        events: merged,
        count: count + missingLiveCount,
        hasLoaded: true,
        error: null,
      });
    })
    .catch((error) => {
      setLocalEventWindowSnapshot(entry, {
        ...entry.snapshot,
        hasLoaded: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    })
    .finally(() => {
      if (entry.loading) {
        entry.loading = null;
      }
    });

  return entry.loading;
};

const applyLocalConversationEvent = (
  entry: LocalConversationEventWindowEntry,
  event: EventRecord,
) => {
  entry.liveEvents.set(event._id, event);
  const existing = entry.snapshot.events.some(
    (candidate) => candidate._id === event._id,
  );
  const merged = mergeEventSources(entry.snapshot.events, [event]);
  const events = capEventsForWindow(merged, entry);
  const count = existing
    ? entry.snapshot.count
    : entry.snapshot.count + countVisibleChatMessageEvents([event]);

  setLocalEventWindowSnapshot(entry, {
    events,
    count,
    hasLoaded: true,
    error: null,
  });
};

const handleLocalChatUpdated = (payload: LocalChatUpdatedPayload | null) => {
  for (const entry of localEventWindows.values()) {
    if (!payload?.event) {
      void refreshLocalEventWindow(entry);
      continue;
    }
    if (
      payload.conversationId &&
      payload.conversationId !== entry.conversationId
    ) {
      continue;
    }
    applyLocalConversationEvent(entry, payload.event as EventRecord);
  }
};

const ensureLocalChatUpdateSubscription = () => {
  if (unsubscribeLocalChatUpdates) {
    return;
  }
  unsubscribeLocalChatUpdates = subscribeToLocalChatUpdates(
    handleLocalChatUpdated,
  );
};

const getOrCreateLocalEventWindow = (
  options: LocalConversationEventWindowOptions,
) => {
  const key = localEventWindowKey(options);
  const existing = localEventWindows.get(key);
  if (existing) {
    return existing;
  }

  const entry: LocalConversationEventWindowEntry = {
    ...options,
    key,
    snapshot: {
      events: EMPTY_EVENTS,
      count: 0,
      hasLoaded: false,
      error: null,
    },
    listeners: new Set(),
    liveEvents: new Map(),
    loading: null,
  };
  localEventWindows.set(key, entry);
  return entry;
};

export const subscribeToLocalConversationEventWindow = (
  options: LocalConversationEventWindowOptions,
  listener: (snapshot: LocalConversationEventSnapshot) => void,
): (() => void) => {
  ensureLocalChatUpdateSubscription();
  const entry = getOrCreateLocalEventWindow(options);
  entry.listeners.add(listener);
  listener(cloneSnapshot(entry.snapshot));
  void refreshLocalEventWindow(entry);

  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      localEventWindows.delete(entry.key);
    }
    if (localEventWindows.size === 0 && unsubscribeLocalChatUpdates) {
      unsubscribeLocalChatUpdates();
      unsubscribeLocalChatUpdates = null;
    }
  };
};

export const reloadLocalConversationEventWindow = (
  options: LocalConversationEventWindowOptions,
): Promise<void> =>
  refreshLocalEventWindow(getOrCreateLocalEventWindow(options));

export const __privateLocalChatStore = {
  handleLocalChatUpdated,
  resetForTests() {
    unsubscribeLocalChatUpdates?.();
    unsubscribeLocalChatUpdates = null;
    localEventWindows.clear();
  },
};
