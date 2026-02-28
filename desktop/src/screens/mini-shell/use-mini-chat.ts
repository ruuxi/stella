/**
 * Mini-shell chat hook — thin composition layer over the shared
 * useStreamingChat hook. Owns mini-shell-specific UI state (message,
 * expanded) and derives events internally.
 */

import { useCallback, useState } from "react";
import { useUiState } from "../../app/state/ui-state";
import { useConversationEvents } from "../../hooks/use-conversation-events";
import { useStreamingChat } from "../../hooks/use-streaming-chat";
import type { ChatContext } from "../../types/electron";

export function useMiniChat(opts: {
  chatContext: ChatContext | null;
  selectedText: string | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const { chatContext, selectedText, setChatContext, setSelectedText } = opts;
  const { state } = useUiState();
  const activeConversationId = state.conversationId;

  // ---- Events subscription ----
  const events = useConversationEvents(activeConversationId ?? undefined);

  // ---- Shared streaming engine ----
  const {
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    sendMessage: sendMessageCore,
  } = useStreamingChat({
    conversationId: activeConversationId,
    events,
  });

  // ---- Mini-shell UI state ----
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(false);

  // ---- No-arg sendMessage wrapper ----
  const sendMessage = useCallback(async () => {
    await sendMessageCore({
      text: message,
      selectedText,
      chatContext,
      onClear: () => {
        setMessage("");
        setSelectedText(null);
        setChatContext(null);
        setExpanded(true);
      },
    });
  }, [message, selectedText, chatContext, sendMessageCore, setSelectedText, setChatContext]);

  return {
    message,
    setMessage,
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    expanded,
    setExpanded,
    events,
    sendMessage,
  };
}
