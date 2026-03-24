import { type EventRecord } from "@/app/chat/lib/event-transforms";
import {
  eventsToHistoryMessages,
  formatMessageTimestamp,
  type ContextEvent,
} from "@/app/chat/lib/history-messages";
import {
  estimateContextEventTokens,
  selectRecentByTokenBudget,
} from "@/app/chat/lib/context-window";

const MAX_EVENTS_PER_CONVERSATION = 2000;

export type LocalHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type LocalSyncMessage = {
  localMessageId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  deviceId?: string;
};

export type LocalAppendEventArgs = {
  conversationId: string;
  type: string;
  payload?: unknown;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  channelEnvelope?: unknown;
  timestamp?: number;
  eventId?: string;
};

const CONTEXT_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
  "tool_request",
  "tool_result",
  "task_started",
  "task_completed",
  "task_failed",
  "task_canceled",
  "microcompact_boundary",
]);

const DEFAULT_HISTORY_MAX_TOKENS = 24_000;
const DEFAULT_WARNING_THRESHOLD_TOKENS = 170_000;
const LEADING_TIME_TAG_RE =
  /^\[(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)(?:,\s+[A-Za-z]{3}\s+\d{1,2})?\]\s*/i;
const TRAILING_TIME_TAG_RE =
  /\s*\n\n\[(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)(?:,\s+[A-Za-z]{3}\s+\d{1,2})?\]$/i;

const getLocalTimezone = (): string | undefined => {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
};

const isMessageEventType = (type: string) =>
  type === "user_message" || type === "assistant_message";

const getSourceTimestamp = (channelEnvelope: unknown): number | undefined => {
  if (!channelEnvelope || typeof channelEnvelope !== "object") return undefined;
  const sourceTimestamp = (channelEnvelope as { sourceTimestamp?: unknown }).sourceTimestamp;
  return typeof sourceTimestamp === "number" && Number.isFinite(sourceTimestamp)
    ? sourceTimestamp
    : undefined;
};

const isChannelMessage = (payload: Record<string, unknown>, channelEnvelope: unknown) => {
  if (channelEnvelope && typeof channelEnvelope === "object") {
    return true;
  }
  const source = payload.source;
  return typeof source === "string" && source.trim().toLowerCase().startsWith("channel:");
};

const withStoredTimestamp = (
  type: string,
  payload: unknown,
  channelEnvelope: unknown,
  timestamp: number,
): unknown => {
  if (!isMessageEventType(type) || !payload || typeof payload !== "object") {
    return payload;
  }

  // Skip assistant messages — the history builder appends timestamps from
  // event metadata when contextText is absent, so we don't need to bake them
  // in at storage time. This avoids the LLM echoing timestamp tags during
  // streaming (which causes layout shifts when later stripped).
  if (type === "assistant_message") {
    return payload;
  }

  const nextPayload = { ...(payload as Record<string, unknown>) };
  const rawText = nextPayload.text;
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return nextPayload;
  }

  let normalizedText = rawText.replace(TRAILING_TIME_TAG_RE, "");
  if (isChannelMessage(nextPayload, channelEnvelope)) {
    normalizedText = normalizedText.replace(LEADING_TIME_TAG_RE, "");
  }
  normalizedText = normalizedText.trimEnd();

  const timezone = getLocalTimezone();
  const effectiveTimestamp = getSourceTimestamp(channelEnvelope) ?? timestamp;
  const { tag } = formatMessageTimestamp(effectiveTimestamp, undefined, timezone);
  nextPayload.contextText = `${normalizedText}\n\n${tag}`;
  return nextPayload;
};

const getLocalChatApi = () => {
  const api = window.electronAPI?.localChat;
  if (!api) {
    throw new Error("[local-chat-store] Electron local chat API is unavailable.");
  }
  return api;
};

export const getOrCreateLocalConversationId = async (): Promise<string> =>
  getLocalChatApi().getOrCreateDefaultConversationId();

export const listLocalEvents = async (
  conversationId: string,
  maxItems = 200,
): Promise<EventRecord[]> =>
  getLocalChatApi().listEvents({
    conversationId,
    maxItems,
  });

export const getLocalEventCount = async (conversationId: string): Promise<number> =>
  getLocalChatApi().getEventCount({ conversationId });

export const appendLocalEvent = async (args: LocalAppendEventArgs): Promise<EventRecord> => {
  const timestamp = args.timestamp ?? Date.now();
  return getLocalChatApi().appendEvent({
    ...args,
    timestamp,
    payload: withStoredTimestamp(
      args.type,
      args.payload,
      args.channelEnvelope,
      timestamp,
    ),
  });
};

/**
 * Build history messages using the same pipeline as the cloud/server-side path:
 * token-budgeted event selection, tool call/result formatting, and micro-compaction.
 *
 * Selection is token-budget-based (default 24 000 tokens, matching the backend).
 */
export const buildLocalHistoryMessages = async (
  conversationId: string,
): Promise<LocalHistoryMessage[]> => {
  const events = await listLocalEvents(conversationId, 800);
  const contextEvents = events.filter((event) => CONTEXT_EVENT_TYPES.has(event.type));
  if (contextEvents.length === 0) return [];

  const newestFirst = [...contextEvents].reverse();
  const selected = selectRecentByTokenBudget({
    itemsNewestFirst: newestFirst,
    maxTokens: DEFAULT_HISTORY_MAX_TOKENS,
    estimateTokens: (event) =>
      estimateContextEventTokens({
        type: event.type,
        payload: event.payload,
        requestId: event.requestId,
      }),
  });

  const chronological = [...selected].reverse();
  const { messages } = eventsToHistoryMessages(
    chronological as ContextEvent[],
    {
      timezone: getLocalTimezone(),
      microcompact: {
        trigger: "auto",
        warningThresholdTokens: DEFAULT_WARNING_THRESHOLD_TOKENS,
      },
    },
  );

  return messages;
};

export const buildLocalSyncMessages = async (
  conversationId: string,
  maxMessages = MAX_EVENTS_PER_CONVERSATION,
): Promise<LocalSyncMessage[]> =>
  getLocalChatApi().listSyncMessages({
    conversationId,
    maxMessages,
  });

export const getLocalSyncCheckpoint = async (conversationId: string): Promise<string | null> =>
  getLocalChatApi().getSyncCheckpoint({ conversationId });

export const setLocalSyncCheckpoint = async (conversationId: string, localMessageId: string) => {
  if (!conversationId || !localMessageId) return;

  await getLocalChatApi().setSyncCheckpoint({
    conversationId,
    localMessageId,
  });
};

export const subscribeToLocalChatUpdates = (listener: () => void): (() => void) =>
  getLocalChatApi().onUpdated(listener);

