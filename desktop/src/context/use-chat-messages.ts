import { useContext } from "react";
import { ChatMessagesContext } from "@/context/chat-messages-context";
import type { MessageRecord } from "../../../runtime/contracts/local-chat.js";

/**
 * Subscribe to the live chat timeline (the per-frame streaming message
 * list) from the nearest `ChatRuntimeProvider`. Components that read this
 * re-render as the streamed reply grows — keep it to the surfaces that
 * actually render the timeline. Throws if used outside the provider so
 * misuse is loud rather than silent.
 *
 * Lives in its own hook-only file so React Fast Refresh doesn't
 * HMR-invalidate the Context module when the hook changes.
 */
export function useChatMessages(): MessageRecord[] {
  const ctx = useContext(ChatMessagesContext);
  if (ctx === null) {
    throw new Error("useChatMessages must be used within ChatRuntimeProvider");
  }
  return ctx;
}
