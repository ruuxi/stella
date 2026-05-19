/**
 * Composes the visible chat timeline from four sources:
 *
 *   - `persistedMessages` — SQLite-backed messages from
 *     `useConversationMessages` (each carries its turn's tool events
 *     pre-grouped on `toolEvents`).
 *   - `optimisticEvents` — fresh user messages emitted by
 *     `useStreamingChat` before the runtime persists them.
 *   - scheduled events — cron / heartbeat user messages still pending
 *     in the scheduler.
 *   - `streamingAssistants` — in-memory assistant messages currently
 *     being streamed from the runtime. Per Option A (standard chat-UI
 *     pattern, c.f. Vercel `useChat`), live stream content is just a
 *     regular assistant row whose text grows over time, NOT a
 *     separate "tail" overlay layered on top of the persisted list.
 *     Each overlay is dropped the moment a persisted row at the same
 *     `(userMessageId, indexInTurn)` slot lands.
 *
 * Optimistic / scheduled overlays are projected to `MessageRecord[]`
 * via `groupEventsIntoMessages`; streaming overlays are already in
 * `MessageRecord` shape. All four merge into one shape and sort by
 * timestamp + id with `persistedMessages` winning on `_id` dedupe.
 *
 * Kept separate from `useConversationMessages` because the overlay
 * needs `optimisticEvents` / `streamingAssistants` from
 * `useStreamingChat`, which in turn needs `persistedMessages` from
 * `useConversationMessages` — a single hook owning all of that would
 * create a dependency loop.
 */
import { useMemo } from "react";
import { useScheduledEvents } from "@/app/chat/hooks/use-scheduled-events";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import { groupEventsIntoMessages } from "@/app/chat/lib/group-events-into-messages";
import type { StreamingAssistantOverlay } from "@/app/chat/streaming/streaming-types";
import type { MessageRecord } from "../../../../../runtime/contracts/local-chat.js";

const SCHEDULED_EVENTS_OVERLAY_MAX = 200;

type UseConversationDisplayMessagesOptions = {
  conversationId: string | null;
  persistedMessages: MessageRecord[];
  optimisticEvents: EventRecord[];
  streamingAssistants: StreamingAssistantOverlay[];
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

/**
 * Materialize a streaming overlay slot into a `MessageRecord` so it
 * slots into the timeline alongside persisted assistant messages.
 * Keep `toolEvents` empty — only persisted assistant rows carry tool
 * decorations (the runtime attaches tools to messages at persist time,
 * and the overlay's lifespan is bounded by the persisted catching up).
 */
const overlayToMessageRecord = (
  overlay: StreamingAssistantOverlay,
): MessageRecord => ({
  _id: overlay._id,
  timestamp: overlay.timestamp,
  type: "assistant_message",
  payload: {
    text: overlay.text,
    userMessageId: overlay.userMessageId,
    ...(overlay.responseTarget
      ? { metadata: { runtime: { responseTarget: overlay.responseTarget } } }
      : {}),
  },
  toolEvents: [],
});

export const useConversationDisplayMessages = ({
  conversationId,
  persistedMessages,
  optimisticEvents,
  streamingAssistants,
}: UseConversationDisplayMessagesOptions): MessageRecord[] => {
  const scheduledEvents = useScheduledEvents({
    conversationId: conversationId ?? undefined,
    enabled: Boolean(conversationId),
    maxItems: SCHEDULED_EVENTS_OVERLAY_MAX,
  });

  // Count persisted assistants per `userMessageId` so the streaming
  // overlay dedupe can drop slots whose persisted counterpart at the
  // same `indexInTurn` has already landed. The persisted row wins —
  // it has the canonical text, tool events, and self-mod metadata.
  const persistedAssistantCountByUserMessageId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const message of persistedMessages) {
      if (message.type !== "assistant_message") continue;
      const payload = message.payload as { userMessageId?: string } | undefined;
      const userMessageId = payload?.userMessageId;
      if (!userMessageId) continue;
      counts.set(userMessageId, (counts.get(userMessageId) ?? 0) + 1);
    }
    return counts;
  }, [persistedMessages]);

  const overlayMessages = useMemo(() => {
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
    const fromEvents =
      overlayEvents.length > 0 ? groupEventsIntoMessages(overlayEvents) : [];

    const streamingOverlay: MessageRecord[] = [];
    for (const slot of streamingAssistants) {
      const persistedCount =
        persistedAssistantCountByUserMessageId.get(slot.userMessageId) ?? 0;
      if (slot.indexInTurn <= persistedCount) {
        // Persisted row at this slot has landed; drop the overlay.
        continue;
      }
      streamingOverlay.push(overlayToMessageRecord(slot));
    }

    if (fromEvents.length === 0 && streamingOverlay.length === 0) {
      return [] as MessageRecord[];
    }
    return [...fromEvents, ...streamingOverlay];
  }, [
    optimisticEvents,
    persistedAssistantCountByUserMessageId,
    scheduledEvents,
    streamingAssistants,
  ]);

  return useMemo(() => {
    if (overlayMessages.length === 0) return persistedMessages;
    return mergeMessageSources(persistedMessages, overlayMessages);
  }, [overlayMessages, persistedMessages]);
};
