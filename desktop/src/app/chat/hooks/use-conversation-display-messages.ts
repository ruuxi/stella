/**
 * Composes the visible chat timeline from three sources:
 *
 *   - `persistedMessages` — SQLite-backed messages from
 *     `useConversationMessages` (each carries its turn's tool events
 *     pre-grouped on `toolEvents`).
 *   - `optimisticEvents` — fresh user messages emitted by
 *     `useStreamingChat` before the runtime persists them.
 *   - scheduled events — cron / heartbeat user messages still pending
 *     in the scheduler.
 *
 * Both overlays are projected to `MessageRecord[]` via
 * `groupEventsIntoMessages` so the chat timeline always speaks one
 * shape, then merged with `persistedMessages` winning on dedupe.
 *
 * Kept separate from `useConversationMessages` because the overlay
 * needs `optimisticEvents` from `useStreamingChat`, which in turn
 * needs `persistedMessages` from `useConversationMessages` — a single
 * hook owning all of that would create a dependency loop.
 *
 * Owns the scheduled events fetch via `useScheduledEvents`. The
 * scheduled overlay cap is small (a handful of pending cron /
 * heartbeat firings per active scheduler), so it doesn't need
 * pagination.
 */
import { useMemo } from "react";
import { useScheduledEvents } from "@/app/chat/hooks/use-scheduled-events";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import { groupEventsIntoMessages } from "@/app/chat/lib/group-events-into-messages";
import type { MessageRecord } from "../../../../../runtime/contracts/local-chat.js";

const SCHEDULED_EVENTS_OVERLAY_MAX = 200;

type UseConversationDisplayMessagesOptions = {
  conversationId: string | null;
  persistedMessages: MessageRecord[];
  optimisticEvents: EventRecord[];
};

const mergeMessageSources = (
  ...sources: MessageRecord[][]
): MessageRecord[] => {
  const seen = new Map<string, MessageRecord>();
  for (const source of sources) {
    for (const message of source) {
      if (!seen.has(message._id)) {
        seen.set(message._id, message);
      }
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a._id.localeCompare(b._id);
  });
};

export const useConversationDisplayMessages = ({
  conversationId,
  persistedMessages,
  optimisticEvents,
}: UseConversationDisplayMessagesOptions): MessageRecord[] => {
  const scheduledEvents = useScheduledEvents({
    conversationId: conversationId ?? undefined,
    enabled: Boolean(conversationId),
    maxItems: SCHEDULED_EVENTS_OVERLAY_MAX,
  });

  const overlayMessages = useMemo(() => {
    if (optimisticEvents.length === 0 && scheduledEvents.length === 0) {
      return [] as MessageRecord[];
    }
    const overlayEvents: EventRecord[] = [];
    for (const event of optimisticEvents) overlayEvents.push(event);
    for (const event of scheduledEvents) {
      if (
        event.type !== "user_message" &&
        event.type !== "assistant_message"
      ) {
        continue;
      }
      if (overlayEvents.some((other) => other._id === event._id)) continue;
      overlayEvents.push(event);
    }
    return groupEventsIntoMessages(overlayEvents);
  }, [optimisticEvents, scheduledEvents]);

  return useMemo(() => {
    if (overlayMessages.length === 0) return persistedMessages;
    return mergeMessageSources(persistedMessages, overlayMessages);
  }, [overlayMessages, persistedMessages]);
};
