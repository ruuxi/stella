import { usePaginatedQuery } from "convex/react";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "@/convex/api";
import {
  getLocalEventCount,
  listLocalEvents,
  subscribeToLocalChatUpdates,
} from "@/app/chat/services/local-chat-store";
import { useChatStore } from "@/context/chat-store";
import type { EventRecord, MessageTurn, StepItem } from "@/app/chat/lib/event-transforms";
import { extractStepsFromEvents, groupEventsIntoTurns } from "@/app/chat/lib/event-transforms";

const EVENT_PAGE_SIZE = 200;
const LOCAL_LOAD_RETRY_MS = 300;
const EMPTY_EVENTS: EventRecord[] = [];
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
  const [localSnapshot, setLocalSnapshot] = useState(() => ({
    visitToken: localWindowVisitToken,
    events: EMPTY_EVENTS,
    count: 0,
    hasLoaded: false,
  }));
  const [localRetryTick, setLocalRetryTick] = useState(0);
  const [scheduledEvents, setScheduledEvents] = useState<EventRecord[]>(EMPTY_EVENTS);
  const [scheduledEventCount, setScheduledEventCount] = useState(0);

  const localMaxItems =
    localWindowState.visitToken === localWindowVisitToken
      ? localWindowState.maxItems
      : EVENT_PAGE_SIZE;
  const pendingLocalMaxItems =
    pendingLocalWindowState.visitToken === localWindowVisitToken
      ? pendingLocalWindowState.maxItems
      : null;
  const activeLocalSnapshot =
    localSnapshot.visitToken === localWindowVisitToken
      ? localSnapshot
      : { visitToken: localWindowVisitToken, events: EMPTY_EVENTS, count: 0, hasLoaded: false };

  const cloudResult = usePaginatedQuery(
    api.events.listEvents,
    storageMode === "cloud" && conversationId
      ? { conversationId }
      : "skip",
    { initialNumItems: EVENT_PAGE_SIZE },
  ) as PaginatedEventsResult | undefined;

  useEffect(() => {
    setLocalSnapshot({
      visitToken: localWindowVisitToken,
      events: EMPTY_EVENTS,
      count: 0,
      hasLoaded: false,
    });
  }, [localWindowVisitToken]);

  useEffect(() => {
    if (storageMode !== "local" || !conversationId) {
      setLocalSnapshot({
        visitToken: localWindowVisitToken,
        events: EMPTY_EVENTS,
        count: 0,
        hasLoaded: true,
      });
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;

    const scheduleRetry = () => {
      if (cancelled || retryTimer !== null) {
        return;
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!cancelled) {
          setLocalRetryTick((current) => current + 1);
        }
      }, LOCAL_LOAD_RETRY_MS);
    };

    const load = async () => {
      try {
        const [events, count] = await Promise.all([
          listLocalEvents(conversationId, localMaxItems),
          getLocalEventCount(conversationId),
        ]);
        if (cancelled) {
          return;
        }
        if (retryTimer !== null) {
          window.clearTimeout(retryTimer);
          retryTimer = null;
        }
        setLocalSnapshot({
          visitToken: localWindowVisitToken,
          events,
          count,
          hasLoaded: true,
        });
      } catch {
        if (cancelled) {
          return;
        }
        setLocalSnapshot({
          visitToken: localWindowVisitToken,
          events: EMPTY_EVENTS,
          count: 0,
          hasLoaded: false,
        });
        scheduleRetry();
      }
    };

    void load();
    const unsubscribe = subscribeToLocalChatUpdates(() => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      void load();
    });

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      unsubscribe();
    };
  }, [conversationId, localMaxItems, localRetryTick, localWindowVisitToken, storageMode]);

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
    () => mergeEventSources(activeLocalSnapshot.events, scheduledEvents),
    [activeLocalSnapshot.events, scheduledEvents],
  );

  const localEventCount =
    storageMode === "local" && conversationId
      ? activeLocalSnapshot.count + scheduledEventCount
      : 0;
  const isLocalLoadingOlder =
    storageMode === "local"
    && pendingLocalMaxItems !== null
    && mergedLocalEvents.length < pendingLocalMaxItems
    && localEventCount > mergedLocalEvents.length;

  const cloudResults = cloudResult?.results ?? EMPTY_EVENTS;
  const cloudStatus = cloudResult?.status ?? "Exhausted";
  const cloudLoadMore = cloudResult?.loadMore ?? NO_OP;

  useEffect(() => {
    if (
      pendingLocalWindowState.visitToken !== localWindowVisitToken
      || pendingLocalWindowState.maxItems === null
    ) {
      return;
    }
    if (
      activeLocalSnapshot.events.length >= pendingLocalWindowState.maxItems
      || localEventCount <= mergedLocalEvents.length
    ) {
      setPendingLocalWindowState({
        visitToken: localWindowVisitToken,
        maxItems: null,
      });
    }
  }, [
    activeLocalSnapshot.events.length,
    localEventCount,
    localWindowVisitToken,
    mergedLocalEvents.length,
    pendingLocalWindowState.maxItems,
    pendingLocalWindowState.visitToken,
  ]);

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
    localMaxItems,
    localWindowVisitToken,
    mergedLocalEvents.length,
    storageMode,
  ]);

  return useMemo(() => {
    if (storageMode === "local") {
      return {
        events: mergedLocalEvents,
        hasOlderEvents: localEventCount > mergedLocalEvents.length,
        isLoadingOlder: isLocalLoadingOlder,
        isInitialLoading:
          Boolean(conversationId)
          && !activeLocalSnapshot.hasLoaded
          && pendingLocalMaxItems === null,
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
    activeLocalSnapshot.hasLoaded,
    cloudResults,
    cloudStatus,
    conversationId,
    isLocalLoadingOlder,
    loadOlder,
    localEventCount,
    mergedLocalEvents,
    pendingLocalMaxItems,
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
