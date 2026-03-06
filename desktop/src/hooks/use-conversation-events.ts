import { usePaginatedQuery } from "convex/react";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "@/convex/api";
import {
  getLocalEventCount,
  listLocalEvents,
  subscribeToLocalChatUpdates,
} from "@/services/local-chat-store";
import type { StepItem } from "@/ui/steps-container";
import { useChatStore } from "@/providers/chat-store";
import type { EventRecord, MessageTurn } from "@/lib/event-transforms";
import { extractStepsFromEvents, groupEventsIntoTurns } from "@/lib/event-transforms";

export type { EventRecord };

const EVENT_PAGE_SIZE = 200;
const EMPTY_EVENTS: EventRecord[] = [];
const localEventsSnapshotCache = new Map<string, EventRecord[]>();
const NO_OP = () => {};

type PaginatedStatus =
  | "LoadingFirstPage"
  | "CanLoadMore"
  | "LoadingMore"
  | "Exhausted";

type PaginatedEventsResult = {
  results: EventRecord[];
  status: PaginatedStatus;
  loadMore: (numItems: number) => void;
};

export type ConversationEventFeed = {
  events: EventRecord[];
  hasOlderEvents: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
  loadOlder: () => void;
};

const areEventListsEqual = (current: EventRecord[], next: EventRecord[]) => {
  if (current.length !== next.length) {
    return false;
  }

  for (let i = 0; i < current.length; i += 1) {
    if (current[i] !== next[i]) {
      return false;
    }
  }

  return true;
};

const getLocalSnapshotCacheKey = (conversationId: string, maxItems: number) =>
  `${conversationId}:${maxItems}`;

const getCachedLocalEventsSnapshot = (
  conversationId: string,
  maxItems: number,
): EventRecord[] => {
  const cacheKey = getLocalSnapshotCacheKey(conversationId, maxItems);
  const current = localEventsSnapshotCache.get(cacheKey) ?? EMPTY_EVENTS;
  const next = listLocalEvents(conversationId, maxItems);
  if (areEventListsEqual(current, next)) {
    return current;
  }
  localEventsSnapshotCache.set(cacheKey, next);
  return next;
};

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

  return [...merged.values()].sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    return a._id.localeCompare(b._id);
  });
};

export const useConversationEventFeed = (
  conversationId?: string,
): ConversationEventFeed => {
  const { storageMode } = useChatStore();
  const localWindowKey = `${storageMode}:${conversationId ?? ""}`;
  const localWindowVisitToken = useMemo(() => Symbol(localWindowKey), [localWindowKey]);
  const [localWindowState, setLocalWindowState] = useState(() => ({
    visitToken: localWindowVisitToken,
    maxItems: EVENT_PAGE_SIZE,
  }));
  const [pendingLocalWindowState, setPendingLocalWindowState] = useState(() => ({
    visitToken: localWindowVisitToken,
    maxItems: null as number | null,
  }));
  const localMaxItems =
    localWindowState.visitToken === localWindowVisitToken
      ? localWindowState.maxItems
      : EVENT_PAGE_SIZE;
  const pendingLocalMaxItems =
    pendingLocalWindowState.visitToken === localWindowVisitToken
      ? pendingLocalWindowState.maxItems
      : null;

  const cloudResult = usePaginatedQuery(
    api.events.listEvents,
    storageMode === "cloud" && conversationId
      ? { conversationId }
      : "skip",
    { initialNumItems: EVENT_PAGE_SIZE },
  ) as PaginatedEventsResult | undefined;

  const subscribeToLocalEvents = useCallback(
    (onStoreChange: () => void) => {
      if (storageMode !== "local" || !conversationId) {
        return () => {};
      }
      return subscribeToLocalChatUpdates(onStoreChange);
    },
    [conversationId, storageMode],
  );

  const getLocalEventsSnapshot = useCallback(() => {
    if (storageMode !== "local" || !conversationId) {
      return EMPTY_EVENTS;
    }
    return getCachedLocalEventsSnapshot(conversationId, localMaxItems);
  }, [conversationId, localMaxItems, storageMode]);

  const localEvents = useSyncExternalStore(
    subscribeToLocalEvents,
    getLocalEventsSnapshot,
    () => EMPTY_EVENTS,
  );
  const [scheduledEvents, setScheduledEvents] = useState<EventRecord[]>(EMPTY_EVENTS);
  const [scheduledEventCount, setScheduledEventCount] = useState(0);

  useEffect(() => {
    if (storageMode !== "local" || !conversationId || !window.electronAPI?.schedule) {
      setScheduledEvents(EMPTY_EVENTS);
      setScheduledEventCount(0);
      return;
    }

    let cancelled = false;
    const scheduleApi = window.electronAPI.schedule;

    const load = async () => {
      try {
        const [events, count] = await Promise.all([
          scheduleApi.listConversationEvents({
            conversationId,
            maxItems: localMaxItems,
          }),
          scheduleApi.getConversationEventCount({ conversationId }),
        ]);
        if (cancelled) {
          return;
        }
        setScheduledEvents(events as EventRecord[]);
        setScheduledEventCount(count);
      } catch {
        if (cancelled) {
          return;
        }
        setScheduledEvents(EMPTY_EVENTS);
        setScheduledEventCount(0);
      }
    };

    void load();
    const unsubscribe = scheduleApi.onUpdated(() => {
      void load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [conversationId, localMaxItems, storageMode]);

  const mergedLocalEvents = useMemo(
    () => mergeEventSources(localEvents, scheduledEvents),
    [localEvents, scheduledEvents],
  );

  const localEventCount =
    storageMode === "local" && conversationId
      ? getLocalEventCount(conversationId) + scheduledEventCount
      : 0;
  const isLocalLoadingOlder =
    storageMode === "local" &&
    pendingLocalMaxItems !== null &&
    mergedLocalEvents.length < pendingLocalMaxItems &&
    localEventCount > mergedLocalEvents.length;

  const cloudResults = cloudResult?.results ?? EMPTY_EVENTS;
  const cloudStatus = cloudResult?.status ?? "Exhausted";
  const cloudLoadMore = cloudResult?.loadMore ?? NO_OP;

  const loadOlder = useCallback(() => {
    if (!conversationId) {
      return;
    }

    if (storageMode === "local") {
      if (localEventCount <= mergedLocalEvents.length) {
        return;
      }

      const nextMaxItems = Math.min(localMaxItems + EVENT_PAGE_SIZE, localEventCount);
      setPendingLocalWindowState({
        visitToken: localWindowVisitToken,
        maxItems: nextMaxItems,
      });
      startTransition(() => {
        setLocalWindowState({
          visitToken: localWindowVisitToken,
          maxItems: nextMaxItems,
        });
      });
      return;
    }

    if (cloudStatus === "CanLoadMore") {
      cloudLoadMore(EVENT_PAGE_SIZE);
    }
  }, [
    cloudLoadMore,
    cloudStatus,
    conversationId,
    localEventCount,
    mergedLocalEvents.length,
    localMaxItems,
    localWindowVisitToken,
    storageMode,
  ]);

  return useMemo(() => {
    if (storageMode === "local") {
      return {
        events: mergedLocalEvents,
        hasOlderEvents: localEventCount > mergedLocalEvents.length,
        isLoadingOlder: isLocalLoadingOlder,
        isInitialLoading: false,
        loadOlder,
      };
    }

    return {
      events: [...cloudResults].reverse(),
      hasOlderEvents:
        cloudStatus === "CanLoadMore" || cloudStatus === "LoadingMore",
      isLoadingOlder: cloudStatus === "LoadingMore",
      isInitialLoading: cloudStatus === "LoadingFirstPage",
      loadOlder,
    };
  }, [
    cloudResults,
    cloudStatus,
    isLocalLoadingOlder,
    loadOlder,
    localEventCount,
    mergedLocalEvents,
    storageMode,
  ]);
};

export const useConversationEvents = (
  conversationId?: string,
) => {
  const feed = useConversationEventFeed(conversationId);
  return feed.events;
};

export const useStepsFromEvents = (events: EventRecord[]): StepItem[] => {
  return useMemo(() => extractStepsFromEvents(events), [events]);
};

export const useMessageTurns = (events: EventRecord[]): MessageTurn[] => {
  return useMemo(() => groupEventsIntoTurns(events), [events]);
};
