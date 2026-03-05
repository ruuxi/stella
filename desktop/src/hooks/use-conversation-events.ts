import { useQuery } from "convex/react";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { api } from "@/convex/api";
import {
  listLocalEvents,
  subscribeToLocalChatUpdates,
} from "@/services/local-chat-store";
import type { StepItem } from "@/ui/steps-container";
import { useChatStore } from "@/providers/chat-store";
import type { EventRecord, MessageTurn } from "@/lib/event-transforms";
import { extractStepsFromEvents, groupEventsIntoTurns } from "@/lib/event-transforms";

export type { EventRecord };

const MAX_EVENTS = 200;
const EMPTY_EVENTS: EventRecord[] = [];
const localEventsSnapshotCache = new Map<string, EventRecord[]>();

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

const getCachedLocalEventsSnapshot = (conversationId: string): EventRecord[] => {
  const current = localEventsSnapshotCache.get(conversationId) ?? EMPTY_EVENTS;
  const next = listLocalEvents(conversationId, MAX_EVENTS);
  if (areEventListsEqual(current, next)) {
    return current;
  }
  localEventsSnapshotCache.set(conversationId, next);
  return next;
};

export const useConversationEvents = (
  conversationId?: string,
) => {
  const { storageMode } = useChatStore();
  const cloudResult = useQuery(
    api.events.listEvents,
    storageMode === "cloud" && conversationId
      ? {
          conversationId,
          paginationOpts: { cursor: null, numItems: 200 },
        }
      : "skip"
  ) as { page: EventRecord[] } | undefined;
  const subscribeToLocalEvents = useCallback((onStoreChange: () => void) => {
    if (storageMode !== "local" || !conversationId) {
      return () => {};
    }
    return subscribeToLocalChatUpdates(onStoreChange);
  }, [storageMode, conversationId]);

  const getLocalEventsSnapshot = useCallback(() => {
    if (storageMode !== "local" || !conversationId) {
      return EMPTY_EVENTS;
    }
    return getCachedLocalEventsSnapshot(conversationId);
  }, [storageMode, conversationId]);

  const localEvents = useSyncExternalStore(
    subscribeToLocalEvents,
    getLocalEventsSnapshot,
    () => EMPTY_EVENTS,
  );

  return useMemo(() => {
    if (storageMode === "local") {
      return localEvents;
    }
    const events = cloudResult?.page ?? [];
    return [...events].reverse();
  }, [storageMode, localEvents, cloudResult?.page]);
};

export const useStepsFromEvents = (events: EventRecord[]): StepItem[] => {
  return useMemo(() => extractStepsFromEvents(events), [events]);
};

export const useMessageTurns = (events: EventRecord[]): MessageTurn[] => {
  return useMemo(() => groupEventsIntoTurns(events), [events]);
};


