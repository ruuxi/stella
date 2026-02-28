/**
 * Mini-shell chat hook — thin composition layer over the shared
 * useStreamingChat hook. Owns mini-shell-specific UI state (message,
 * expanded) and derives storageMode / events internally.
 */

import { useCallback, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useUiState } from "../../app/state/ui-state";
import { api } from "../../convex/api";
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

  // ---- Derive storageMode ----
  const { isAuthenticated } = useConvexAuth();
  const accountMode = useQuery(
    api.data.preferences.getAccountMode,
    isAuthenticated ? {} : "skip",
  ) as "private_local" | "connected" | undefined;
  const syncMode = useQuery(
    api.data.preferences.getSyncMode,
    isAuthenticated && accountMode === "connected" ? {} : "skip",
  ) as "on" | "off" | undefined;
  const storageMode =
    isAuthenticated &&
    accountMode === "connected" &&
    (syncMode ?? "on") !== "off"
      ? "cloud"
      : "local";

  // ---- Events subscription ----
  const events = useConversationEvents(activeConversationId ?? undefined, {
    source: storageMode,
  });

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
    storageMode,
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
