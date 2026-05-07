import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { countVisibleChatMessageEvents } from "../../../../../runtime/chat-event-visibility.js";
import { useChatStore } from "@/context/chat-store";
import {
  mergeEventSources,
  type EventRecord,
} from "@/app/chat/lib/event-transforms";
import {
  capEventWindow,
  stabilizeEventList,
  type StableEventListState,
} from "@/app/chat/lib/stable-rows";
import {
  CLOUD_EVENT_PAGE_SIZE,
  useCloudConversationEvents,
} from "./use-cloud-conversation-events";
import { useLocalConversationEvents } from "./use-local-conversation-events";
import { useScheduledEvents } from "./use-scheduled-events";

const EVENT_PAGE_SIZE = CLOUD_EVENT_PAGE_SIZE;

type ConversationEventFeed = {
  events: EventRecord[];
  hasOlderEvents: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
  loadOlder: () => void;
};

/**
 * Merges three event sources into a single chronological stream:
 *
 * 1. Cloud — Convex paginated query (cloud-storage mode only).
 * 2. Local — SQLite subscription on `localChat:listEvents` (local-storage
 *    mode only).
 * 3. Scheduled — overlay of pending scheduler-owned events for the
 *    conversation (local-storage mode only).
 *
 * Owns the local window-size + pending-load state so local and
 * scheduled queries stay in lockstep when the user pages backwards.
 */
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

  const localMaxItems =
    localWindowState.visitToken === localWindowVisitToken
      ? localWindowState.maxItems
      : EVENT_PAGE_SIZE;
  const pendingLocalMaxItems =
    pendingLocalWindowState.visitToken === localWindowVisitToken
      ? pendingLocalWindowState.maxItems
      : null;

  const isLocalMode = storageMode === "local";
  const isCloudMode = storageMode === "cloud";

  const cloud = useCloudConversationEvents({
    conversationId,
    enabled: isCloudMode,
  });

  const { snapshot: activeLocalSnapshot } = useLocalConversationEvents({
    conversationId,
    enabled: isLocalMode,
    maxItems: localMaxItems,
    visitToken: localWindowVisitToken,
  });

  const { events: scheduledEvents, count: scheduledEventCount } =
    useScheduledEvents({
      conversationId,
      enabled: isLocalMode,
      maxItems: localMaxItems,
    });

  const mergedLocalEvents = useMemo(
    () => mergeEventSources(activeLocalSnapshot.events, scheduledEvents),
    [activeLocalSnapshot.events, scheduledEvents],
  );

  const loadedVisibleLocalMessageCount = useMemo(
    () => countVisibleChatMessageEvents(activeLocalSnapshot.events),
    [activeLocalSnapshot.events],
  );

  const localVisibleMessageCount =
    isLocalMode && conversationId ? activeLocalSnapshot.count : 0;
  const isLocalLoadingOlder =
    isLocalMode &&
    pendingLocalMaxItems !== null &&
    (loadedVisibleLocalMessageCount <
      Math.min(pendingLocalMaxItems, localVisibleMessageCount) ||
      scheduledEvents.length <
        Math.min(pendingLocalMaxItems, scheduledEventCount));

  // Reuse prior `EventRecord` references whenever the underlying event id
  // hasn't changed, then cap the rendered window. This keeps every
  // downstream `useMemo([events])` chain (turn grouping, view models,
  // running-tool extraction, footer-task derivation, …) bailout-eligible
  // — without it, every IPC tick / Convex pagination tick allocates a new
  // array of new objects and forces O(N) recompute on a chat of size N.
  const stableEventsRef = useRef<StableEventListState | null>(null);
  const cappedEventsRef = useRef<EventRecord[] | null>(null);
  const eventWindowState = useMemo(() => {
    const source = isLocalMode ? mergedLocalEvents : cloud.events;
    const stable = stabilizeEventList(source, stableEventsRef.current);
    const capped = capEventWindow(stable.result, cappedEventsRef.current);
    return { stable, capped };
  }, [cloud.events, isLocalMode, mergedLocalEvents]);
  const events = eventWindowState.capped;

  useLayoutEffect(() => {
    stableEventsRef.current = eventWindowState.stable;
    cappedEventsRef.current = eventWindowState.capped;
  }, [eventWindowState]);

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

    if (isLocalMode) {
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

    if (cloud.status === "CanLoadMore") {
      cloud.loadMore(EVENT_PAGE_SIZE);
    }
  }, [
    cloud,
    conversationId,
    isLocalMode,
    localMaxItems,
    localVisibleMessageCount,
    localWindowVisitToken,
    loadedVisibleLocalMessageCount,
    scheduledEventCount,
    scheduledEvents.length,
  ]);

  return useMemo(() => {
    if (isLocalMode) {
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
        cloud.status === "CanLoadMore" || cloud.status === "LoadingMore",
      isLoadingOlder: cloud.status === "LoadingMore",
      isInitialLoading: cloud.status === "LoadingFirstPage",
      loadOlder,
    };
  }, [
    activeLocalSnapshot.hasLoaded,
    cloud.status,
    conversationId,
    events,
    isLocalLoadingOlder,
    isLocalMode,
    loadOlder,
    loadedVisibleLocalMessageCount,
    localVisibleMessageCount,
    scheduledEventCount,
    scheduledEvents.length,
    pendingLocalMaxItems,
  ]);
};
