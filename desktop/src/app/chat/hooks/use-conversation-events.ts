import { usePaginatedQuery } from "convex/react";
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/convex/api";
import {
  subscribeToLocalConversationEventWindow,
  type LocalConversationEventSnapshot,
} from "@/app/chat/services/local-chat-store";
import { showToast } from "@/ui/toast";
import { countVisibleChatMessageEvents } from "../../../../../runtime/chat-event-visibility.js";
import { useChatStore } from "@/context/chat-store";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import {
  capEventWindow,
  stabilizeEventList,
  type StableEventListState,
} from "@/app/chat/lib/stable-rows";

const EVENT_PAGE_SIZE = 200;
const LOCAL_LOAD_RETRY_MS = 300;
const EMPTY_EVENTS: EventRecord[] = [];
const NO_OP = () => {};
const EMPTY_LOCAL_SNAPSHOT: LocalConversationEventSnapshot = {
  events: EMPTY_EVENTS,
  count: 0,
  hasLoaded: false,
  error: null,
};

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

type ConversationEventFeed = {
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
  const localWindowVisitToken = useMemo(
    () => Symbol(localWindowKey),
    [localWindowKey],
  );
  const [localWindowState, setLocalWindowState] = useState(() => ({
    visitToken: localWindowVisitToken,
    maxItems: EVENT_PAGE_SIZE,
  }));
  const [pendingLocalWindowState, setPendingLocalWindowState] = useState(
    () => ({
      visitToken: localWindowVisitToken,
      maxItems: null as number | null,
    }),
  );
  const [localSnapshot, setLocalSnapshot] = useState(() => ({
    visitToken: localWindowVisitToken,
    snapshot: EMPTY_LOCAL_SNAPSHOT,
  }));
  const lastLocalLoadToastAtRef = useRef(0);
  const [localRetryTick, setLocalRetryTick] = useState(0);
  const [scheduledEvents, setScheduledEvents] =
    useState<EventRecord[]>(EMPTY_EVENTS);
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
      ? localSnapshot.snapshot
      : EMPTY_LOCAL_SNAPSHOT;

  const cloudResult = usePaginatedQuery(
    api.events.listEvents,
    storageMode === "cloud" && conversationId ? { conversationId } : "skip",
    { initialNumItems: EVENT_PAGE_SIZE },
  ) as PaginatedEventsResult | undefined;

  useEffect(() => {
    setLocalSnapshot({
      visitToken: localWindowVisitToken,
      snapshot: EMPTY_LOCAL_SNAPSHOT,
    });
  }, [localWindowVisitToken]);

  useEffect(() => {
    if (storageMode !== "local" || !conversationId) {
      setLocalSnapshot({
        visitToken: localWindowVisitToken,
        snapshot: {
          events: EMPTY_EVENTS,
          count: 0,
          hasLoaded: true,
          error: null,
        },
      });
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    const options = {
      conversationId,
      maxItems: localMaxItems,
      windowBy: "visible_messages" as const,
    };

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

    const handleSnapshot = (snapshot: LocalConversationEventSnapshot) => {
      if (cancelled) {
        return;
      }
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      setLocalSnapshot({
        visitToken: localWindowVisitToken,
        snapshot,
      });

      if (!snapshot.error) {
        return;
      }
      const now = Date.now();
      if (now - lastLocalLoadToastAtRef.current > 10_000) {
        lastLocalLoadToastAtRef.current = now;
        showToast({
          title: "Couldn’t load chat history",
          description:
            snapshot.error.message || "Stella will retry in a moment.",
          variant: "error",
        });
      }
      scheduleRetry();
    };

    const unsubscribe = subscribeToLocalConversationEventWindow(
      options,
      handleSnapshot,
    );

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      unsubscribe();
    };
  }, [
    conversationId,
    localMaxItems,
    localRetryTick,
    localWindowVisitToken,
    storageMode,
  ]);

  useEffect(() => {
    if (
      storageMode !== "local" ||
      !conversationId ||
      !window.electronAPI?.schedule
    ) {
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

  const loadedVisibleLocalMessageCount = useMemo(
    () => countVisibleChatMessageEvents(activeLocalSnapshot.events),
    [activeLocalSnapshot.events],
  );

  const localVisibleMessageCount =
    storageMode === "local" && conversationId ? activeLocalSnapshot.count : 0;
  const isLocalLoadingOlder =
    storageMode === "local" &&
    pendingLocalMaxItems !== null &&
    (loadedVisibleLocalMessageCount <
      Math.min(pendingLocalMaxItems, localVisibleMessageCount) ||
      scheduledEvents.length <
        Math.min(pendingLocalMaxItems, scheduledEventCount));

  const cloudResults = cloudResult?.results ?? EMPTY_EVENTS;
  const cloudStatus = cloudResult?.status ?? "Exhausted";
  const cloudLoadMore = cloudResult?.loadMore ?? NO_OP;

  const reversedCloudEvents = useMemo(
    () =>
      storageMode === "cloud" ? [...cloudResults].reverse() : EMPTY_EVENTS,
    [cloudResults, storageMode],
  );

  // Reuse prior `EventRecord` references whenever the underlying event id
  // hasn't changed, then cap the rendered window. This keeps every
  // downstream `useMemo([events])` chain (turn grouping, view models,
  // running-tool extraction, footer-task derivation, …) bailout-eligible
  // — without it, every IPC tick / Convex pagination tick allocates a new
  // array of new objects and forces O(N) recompute on a chat of size N.
  const stableEventsRef = useRef<StableEventListState | null>(null);
  const cappedEventsRef = useRef<EventRecord[] | null>(null);
  const events = useMemo(() => {
    const source =
      storageMode === "local" ? mergedLocalEvents : reversedCloudEvents;
    const stable = stabilizeEventList(source, stableEventsRef.current);
    stableEventsRef.current = stable;
    const capped = capEventWindow(stable.result, cappedEventsRef.current);
    cappedEventsRef.current = capped;
    return capped;
  }, [mergedLocalEvents, reversedCloudEvents, storageMode]);

  // Reset stabilizer state when the conversation switches so a brand-new
  // chat doesn't inherit stale entries from the previous one.
  useEffect(() => {
    stableEventsRef.current = null;
    cappedEventsRef.current = null;
  }, [conversationId, storageMode]);

  useEffect(() => {
    if (
      pendingLocalWindowState.visitToken !== localWindowVisitToken ||
      pendingLocalWindowState.maxItems === null
    ) {
      return;
    }
    if (
      loadedVisibleLocalMessageCount >=
        Math.min(pendingLocalWindowState.maxItems, localVisibleMessageCount) &&
      scheduledEvents.length >=
        Math.min(pendingLocalWindowState.maxItems, scheduledEventCount)
    ) {
      setPendingLocalWindowState({
        visitToken: localWindowVisitToken,
        maxItems: null,
      });
    }
  }, [
    loadedVisibleLocalMessageCount,
    localVisibleMessageCount,
    localWindowVisitToken,
    pendingLocalWindowState.maxItems,
    pendingLocalWindowState.visitToken,
    scheduledEventCount,
    scheduledEvents.length,
  ]);

  const loadOlder = useCallback(() => {
    if (!conversationId) {
      return;
    }

    if (storageMode === "local") {
      const hasOlderLocalMessages =
        localVisibleMessageCount > loadedVisibleLocalMessageCount;
      const hasOlderScheduledEvents =
        scheduledEventCount > scheduledEvents.length;
      if (!hasOlderLocalMessages && !hasOlderScheduledEvents) {
        return;
      }

      const nextMaxItems = Math.min(
        localMaxItems + EVENT_PAGE_SIZE,
        Math.max(localVisibleMessageCount, scheduledEventCount),
      );
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
    localMaxItems,
    localVisibleMessageCount,
    localWindowVisitToken,
    loadedVisibleLocalMessageCount,
    scheduledEventCount,
    scheduledEvents.length,
    storageMode,
  ]);

  return useMemo(() => {
    if (storageMode === "local") {
      return {
        events,
        hasOlderEvents:
          localVisibleMessageCount > loadedVisibleLocalMessageCount ||
          scheduledEventCount > scheduledEvents.length,
        isLoadingOlder: isLocalLoadingOlder,
        isInitialLoading:
          Boolean(conversationId) &&
          !activeLocalSnapshot.hasLoaded &&
          pendingLocalMaxItems === null,
        loadOlder,
      };
    }

    return {
      events,
      hasOlderEvents:
        cloudStatus === "CanLoadMore" || cloudStatus === "LoadingMore",
      isLoadingOlder: cloudStatus === "LoadingMore",
      isInitialLoading: cloudStatus === "LoadingFirstPage",
      loadOlder,
    };
  }, [
    activeLocalSnapshot.hasLoaded,
    cloudStatus,
    conversationId,
    events,
    isLocalLoadingOlder,
    loadOlder,
    loadedVisibleLocalMessageCount,
    localVisibleMessageCount,
    scheduledEventCount,
    scheduledEvents.length,
    pendingLocalMaxItems,
    storageMode,
  ]);
};
