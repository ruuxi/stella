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
 *     separate "tail" overlay layered on top of the persisted list. If
 *     SQLite catches up while the live row is still present, the live
 *     row keeps ownership of the visible text and borrows persisted
 *     metadata/tool events from the matching `(userMessageId,
 *     indexInTurn)` slot.
 *
 * Optimistic / scheduled overlays are projected to `MessageRecord[]`
 * via `groupEventsIntoMessages`; streaming overlays are already in
 * `MessageRecord` shape. All four merge into one shape and sort by
 * timestamp + id. For active streamed assistant slots, the live row
 * masks its persisted twin so completion does not swap the rendered
 * message source just because SQLite acknowledged the final text.
 *
 * Kept separate from `useConversationMessages` because the overlay
 * needs `optimisticEvents` / `streamingAssistants` from
 * `useStreamingChat`, which in turn needs `persistedMessages` from
 * `useConversationMessages` — a single hook owning all of that would
 * create a dependency loop.
 */
import { useMemo } from "react";
import { useScheduledEvents } from "@/features/chat/hooks/use-scheduled-events";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import { groupEventsIntoMessages } from "@/features/chat/lib/group-events-into-messages";
import type { StreamingAssistantOverlay } from "@/features/chat/streaming/streaming-types";
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

const getAssistantUserMessageId = (
  message: MessageRecord,
): string | undefined => {
  if (message.type !== "assistant_message") return undefined;
  const payload = message.payload as { userMessageId?: string } | undefined;
  const userMessageId = payload?.userMessageId;
  return typeof userMessageId === "string" && userMessageId.length > 0
    ? userMessageId
    : undefined;
};

export const getPersistedAssistantSlots = (
  persistedMessages: MessageRecord[],
): Map<string, MessageRecord[]> => {
  const slots = new Map<string, MessageRecord[]>();
  for (const message of persistedMessages) {
    const userMessageId = getAssistantUserMessageId(message);
    if (!userMessageId) continue;
    const current = slots.get(userMessageId);
    if (current) {
      current.push(message);
    } else {
      slots.set(userMessageId, [message]);
    }
  }
  return slots;
};

/**
 * Materialize a streaming overlay slot into a `MessageRecord` so it
 * slots into the timeline alongside persisted assistant messages.
 * When the matching persisted row exists, keep the live row's text and
 * synthetic id but borrow canonical persisted metadata/decorations.
 */
export const overlayToMessageRecord = (
  overlay: StreamingAssistantOverlay,
  persisted?: MessageRecord,
): MessageRecord => ({
  ...(persisted ?? {}),
  _id: overlay._id,
  timestamp: overlay.timestamp,
  type: "assistant_message",
  payload: {
    ...(persisted?.payload ?? {}),
    text: overlay.text,
    userMessageId: overlay.userMessageId,
    metadata: {
      ...((
        persisted?.payload as { metadata?: Record<string, unknown> } | undefined
      )?.metadata ?? {}),
      runtime: {
        ...((
          persisted?.payload as
            | { metadata?: { runtime?: Record<string, unknown> } }
            | undefined
        )?.metadata?.runtime ?? {}),
        isStreaming: !overlay.locked,
        ...(overlay.responseTarget
          ? { responseTarget: overlay.responseTarget }
          : {}),
      },
    },
  },
  toolEvents: persisted?.toolEvents ?? [],
});

export const mergeConversationDisplayMessageSources = (args: {
  persistedMessages: MessageRecord[];
  overlayMessages: MessageRecord[];
  streamingAssistants: StreamingAssistantOverlay[];
  persistedAssistantSlots: Map<string, MessageRecord[]>;
}): MessageRecord[] => {
  const {
    persistedMessages,
    overlayMessages,
    streamingAssistants,
    persistedAssistantSlots,
  } = args;
  if (streamingAssistants.length === 0) {
    return overlayMessages.length === 0
      ? persistedMessages
      : mergeMessageSources(persistedMessages, overlayMessages);
  }

  const maskedPersistedIds = new Set<string>();
  for (const slot of streamingAssistants) {
    const persisted = persistedAssistantSlots.get(slot.userMessageId)?.[
      slot.indexInTurn - 1
    ];
    if (persisted) {
      maskedPersistedIds.add(persisted._id);
    }
  }

  const persistedMessagesForDisplay =
    maskedPersistedIds.size === 0
      ? persistedMessages
      : persistedMessages.filter(
          (message) => !maskedPersistedIds.has(message._id),
        );

  if (overlayMessages.length === 0) {
    return persistedMessagesForDisplay;
  }
  return mergeMessageSources(persistedMessagesForDisplay, overlayMessages);
};

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

  const persistedAssistantSlots = useMemo(
    () => getPersistedAssistantSlots(persistedMessages),
    [persistedMessages],
  );

  const overlayMessages = useMemo(() => {
    const overlayEvents: EventRecord[] = [];
    for (const event of optimisticEvents) overlayEvents.push(event);
    for (const event of scheduledEvents) {
      if (event.type !== "user_message" && event.type !== "assistant_message") {
        continue;
      }
      if (overlayEvents.some((other) => other._id === event._id)) continue;
      overlayEvents.push(event);
    }
    const fromEvents =
      overlayEvents.length > 0 ? groupEventsIntoMessages(overlayEvents) : [];

    const streamingOverlay: MessageRecord[] = [];
    for (const slot of streamingAssistants) {
      const persisted = persistedAssistantSlots.get(slot.userMessageId)?.[
        slot.indexInTurn - 1
      ];
      streamingOverlay.push(overlayToMessageRecord(slot, persisted));
    }

    if (fromEvents.length === 0 && streamingOverlay.length === 0) {
      return [] as MessageRecord[];
    }
    return [...fromEvents, ...streamingOverlay];
  }, [
    optimisticEvents,
    persistedAssistantSlots,
    scheduledEvents,
    streamingAssistants,
  ]);

  return useMemo(
    () =>
      mergeConversationDisplayMessageSources({
        persistedMessages,
        overlayMessages,
        streamingAssistants,
        persistedAssistantSlots,
      }),
    [
      overlayMessages,
      persistedAssistantSlots,
      persistedMessages,
      streamingAssistants,
    ],
  );
};
