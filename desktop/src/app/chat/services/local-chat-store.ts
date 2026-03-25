import { type EventRecord } from "@/app/chat/lib/event-transforms";
import {
  eventsToHistoryMessages,
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
const getLocalTimezone = (): string | undefined => {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
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
