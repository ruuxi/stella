import { useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/convex/api";
import {
  listLocalEvents,
  subscribeToLocalChatUpdates,
} from "@/services/local-chat-store";
import type { StepItem } from "@/ui/steps-container";
import { useChatStore } from "@/providers/chat-store";

export type { EventRecord } from "@/lib/event-transforms";

import type { EventRecord, MessageTurn } from "@/lib/event-transforms";
import { extractStepsFromEvents, groupEventsIntoTurns } from "@/lib/event-transforms";

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
  const [localEvents, setLocalEvents] = useState<EventRecord[]>([]);

  useEffect(() => {
    if (storageMode !== "local" || !conversationId) {
      setLocalEvents([]);
      return;
    }

    const refresh = () => {
      setLocalEvents(listLocalEvents(conversationId, 200));
    };

    refresh();
    return subscribeToLocalChatUpdates(refresh);
  }, [storageMode, conversationId]);

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


