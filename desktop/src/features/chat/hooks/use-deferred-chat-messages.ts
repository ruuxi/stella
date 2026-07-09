import { useRef } from "react";
import type { MessageRecord } from "../../../../../runtime/contracts/local-chat.js";

/**
 * Keep the last painted timeline stable during direct user scrolling.
 * Streaming continues upstream and the newest array is applied immediately
 * when scrolling settles, so no content is dropped or delayed at rest.
 */
export function useDeferredChatMessages(
  messages: MessageRecord[],
  deferUpdates: boolean,
  scopeKey?: string | null,
): MessageRecord[] {
  const paintedMessagesRef = useRef(messages);
  const scopeKeyRef = useRef(scopeKey);
  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey;
    paintedMessagesRef.current = messages;
  } else if (!deferUpdates) {
    paintedMessagesRef.current = messages;
  }
  return deferUpdates ? paintedMessagesRef.current : messages;
}
