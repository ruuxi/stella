import { type EventRecord } from "@/app/chat/lib/event-transforms";
import type { LocalChatEventWindowMode } from "../../../../../runtime/chat-event-visibility.js";

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

export const subscribeToLocalChatUpdates = (listener: () => void): (() => void) =>
  getLocalChatApi().onUpdated(listener);
