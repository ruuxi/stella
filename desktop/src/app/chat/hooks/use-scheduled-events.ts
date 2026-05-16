import { useEffect, useState } from "react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";

const EMPTY_EVENTS: EventRecord[] = [];

type UseScheduledEventsOptions = {
  conversationId: string | undefined;
  enabled: boolean;
  /** Maximum number of scheduled events to surface (window cap). */
  maxItems: number;
};

/**
 * Pulls the per-conversation scheduler-pending events for use as a
 * synthetic overlay on top of the SQLite-backed message stream.
 * Refreshes whenever the scheduler service signals an update.
 *
 * Scheduled events are rare (a handful per active cron / heartbeat) so
 * the renderer takes them in bulk up to `maxItems`; there's no
 * pagination and no separate total-count read.
 */
export function useScheduledEvents({
  conversationId,
  enabled,
  maxItems,
}: UseScheduledEventsOptions): EventRecord[] {
  const [events, setEvents] = useState<EventRecord[]>(EMPTY_EVENTS);

  useEffect(() => {
    if (!enabled || !conversationId || !window.electronAPI?.schedule) {
      setEvents(EMPTY_EVENTS);
      return;
    }

    let cancelled = false;
    const scheduleApi = window.electronAPI.schedule;

    const load = async () => {
      try {
        const nextEvents = await scheduleApi.listConversationEvents({
          conversationId,
          maxItems,
        });
        if (cancelled) {
          return;
        }
        setEvents(nextEvents as EventRecord[]);
      } catch {
        if (cancelled) {
          return;
        }
        setEvents(EMPTY_EVENTS);
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

  return events;
}
