import { type EventRecord } from "@/app/chat/lib/event-transforms";
import {
  buildLocalHistoryFromEvents,
  LOCAL_CONTEXT_EVENT_TYPES,
  type LocalHistoryMessage,
} from "../../../../runtime/kernel/local-history.js";
import type { LocalChatEventWindowMode } from "../../../../runtime/chat-event-visibility.js";

export type { LocalHistoryMessage } from "../../../../runtime/kernel/local-history.js";

const MAX_EVENTS_PER_CONVERSATION = 2000;

export type LocalSyncMessage = {
  localMessageId: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  deviceId?: string;
};

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
  options?: {
    windowBy?: LocalChatEventWindowMode;
  },
): Promise<EventRecord[]> =>
  getLocalChatApi().listEvents({
    conversationId,
    maxItems,
    ...(options?.windowBy ? { windowBy: options.windowBy } : {}),
  });

export const getLocalEventCount = async (
  conversationId: string,
  options?: {
    countBy?: LocalChatEventWindowMode;
  },
): Promise<number> =>
  getLocalChatApi().getEventCount({
    conversationId,
    ...(options?.countBy ? { countBy: options.countBy } : {}),
  });

export const buildLocalHistoryMessages = async (
  conversationId: string,
): Promise<LocalHistoryMessage[]> => {
  const events = await listLocalEvents(conversationId, 800);
  const contextEvents = events.filter((event) => LOCAL_CONTEXT_EVENT_TYPES.has(event.type));
  if (contextEvents.length === 0) return [];
  return buildLocalHistoryFromEvents({
    events: contextEvents,
    maxTokens: DEFAULT_HISTORY_MAX_TOKENS,
    timezone: getLocalTimezone(),
    warningThresholdTokens: DEFAULT_WARNING_THRESHOLD_TOKENS,
  });
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
