import { useEffect, useState } from "react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";

const EMPTY_EVENTS: EventRecord[] = [];

type UseScheduledEventsOptions = {
  conversationId: string | undefined;
  enabled: boolean;
  /** Maximum number of scheduled events to surface (window cap). */
  maxItems: number;
};

type UseScheduledEventsResult = {
  events: EventRecord[];
  /** Total scheduled events available for this conversation, regardless
   *  of the current window cap. */
  count: number;
};

/**
 * Pulls the per-conversation scheduled events overlay from the local
 * scheduler, refreshing whenever the scheduler service signals an
 * update. Driven by an external `maxItems` so the parent feed can
 * keep scheduled + local windows in lockstep.
 */
export function useScheduledEvents({
  conversationId,
  enabled,
  maxItems,
}: UseScheduledEventsOptions): UseScheduledEventsResult {
  const [events, setEvents] = useState<EventRecord[]>(EMPTY_EVENTS);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled || !conversationId || !window.electronAPI?.schedule) {
      setEvents(EMPTY_EVENTS);
      setCount(0);
      return;
    }

    let cancelled = false;
    const scheduleApi = window.electronAPI.schedule;

    const load = async () => {
      try {
        const [nextEvents, nextCount] = await Promise.all([
          scheduleApi.listConversationEvents({
            conversationId,
            maxItems,
          }),
          scheduleApi.getConversationEventCount({ conversationId }),
        ]);
        if (cancelled) {
          return;
        }
        setEvents(nextEvents as EventRecord[]);
        setCount(nextCount);
      } catch {
        if (cancelled) {
          return;
        }
        setEvents(EMPTY_EVENTS);
        setCount(0);
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
  }, [conversationId, enabled, maxItems]);

  return { events, count };
}
