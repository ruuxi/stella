/**
 * Slim renderer-side wrappers for the few non-timeline consumers that
 * still need raw event-log access. The chat surfaces themselves read
 * from `local-message-store.ts` / `local-activity-store.ts` /
 * `local-files-store.ts` — this module is intentionally tiny:
 *
 *   - `getOrCreateLocalConversationId` — bootstrap helper used before
 *     any conversation context exists.
 *   - `listLocalEvents` — used by onboarding (`WelcomeDialog` reads the
 *     welcome `assistant_message`; `home/categories` reads
 *     `home_suggestions`). Both look up auxiliary event types that
 *     aren't part of the message/activity/files streams.
 *   - `subscribeToLocalChatUpdates` — push notifications backing both
 *     of the above so they refresh when the runtime persists a new
 *     auxiliary event.
 *
 * Anything that wants the chat timeline should use the purpose-built
 * stream hooks instead — don't reach for `listLocalEvents` to render
 * messages.
 */
import { type EventRecord } from "@/app/chat/lib/event-transforms";
import type { LocalChatUpdatedPayload } from "../../../../../runtime/contracts/local-chat.js";

const getLocalChatApi = () => {
  const api = window.electronAPI?.localChat;
  if (!api) {
    throw new Error(
      "[local-chat-store] Electron local chat API is unavailable.",
    );
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

export const subscribeToLocalChatUpdates = (
  listener: (payload: LocalChatUpdatedPayload | null) => void,
): (() => void) => getLocalChatApi().onUpdated(listener);
