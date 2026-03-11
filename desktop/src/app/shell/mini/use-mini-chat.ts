import { useCallback, useEffect, useMemo, useState } from "react";
import { useUiState } from "@/context/ui-state";
import { useIpcQuery } from "@/shared/hooks/use-ipc-query";
import type {
  ChatContext,
  MiniBridgeResponse,
  MiniBridgeSnapshot,
} from "@/types/electron";
import type { EventRecord } from "@/app/chat/lib/event-transforms";

const createEmptySnapshot = (conversationId: string | null): MiniBridgeSnapshot => ({
  conversationId,
  events: [],
  streamingText: "",
  reasoningText: "",
  isStreaming: false,
  pendingUserMessageId: null,
});

export function useMiniChat(opts: {
  isActive?: boolean;
  chatContext: ChatContext | null;
  selectedText: string | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const { isActive = true, chatContext, selectedText, setChatContext, setSelectedText } = opts;
  const { state } = useUiState();
  const activeConversationId = state.conversationId;
  const currentConversationId = activeConversationId ?? null;

  const [message, setMessage] = useState("");
  const [liveSnapshot, setLiveSnapshot] = useState<MiniBridgeSnapshot | null>(null);
  const snapshotRequest = useMemo(
    () => ({
      type: "query:snapshot" as const,
      conversationId: currentConversationId,
    }),
    [currentConversationId],
  );
  const selectSnapshot = useCallback((response: MiniBridgeResponse) => {
    if (response.type !== "query:snapshot") {
      return null;
    }
    return response.snapshot;
  }, []);

  const {
    data: initialSnapshot,
    loading: isLoadingSnapshot,
    error: snapshotError,
    refetch,
  } = useIpcQuery<MiniBridgeSnapshot>({
    enabled: isActive,
    request: snapshotRequest,
    select: selectSnapshot,
  });

  const snapshot = useMemo(() => {
    if (liveSnapshot?.conversationId === currentConversationId) {
      return liveSnapshot;
    }

    if (initialSnapshot?.conversationId === currentConversationId) {
      return initialSnapshot;
    }

    return createEmptySnapshot(currentConversationId);
  }, [currentConversationId, initialSnapshot, liveSnapshot]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    const unsubscribe = window.electronAPI?.mini.onUpdate?.((update) => {
      if (update.type !== "snapshot") {
        return;
      }

      if (
        activeConversationId &&
        update.snapshot.conversationId !== activeConversationId
      ) {
        return;
      }

      setLiveSnapshot(update.snapshot);
    });

    return () => {
      unsubscribe?.();
    };
  }, [activeConversationId, isActive]);

  const sendMessage = useCallback(async () => {
    if (!window.electronAPI?.mini.request || !activeConversationId) {
      return;
    }

    const trimmedMessage = message.trim();
    const hasContext =
      Boolean(selectedText) ||
      Boolean(chatContext?.window) ||
      Boolean(chatContext?.regionScreenshots?.length);

    if (!trimmedMessage && !hasContext) {
      return;
    }

    const response = await window.electronAPI.mini.request({
      type: "mutation:sendMessage",
      conversationId: activeConversationId,
      text: message,
      selectedText,
      chatContext,
    });

    if (response.type === "error") {
      console.error("[miniBridge] sendMessage failed:", response.message);
      return;
    }

    if (response.type === "mutation:sendMessage" && response.accepted) {
      setMessage("");
      setSelectedText(null);
      setChatContext(null);
      void refetch();
    }
  }, [
    activeConversationId,
    chatContext,
    message,
    refetch,
    selectedText,
    setChatContext,
    setSelectedText,
  ]);

  const cancelStream = useCallback(async () => {
    if (!window.electronAPI?.mini.request || !activeConversationId) {
      return;
    }

    const response = await window.electronAPI.mini.request({
      type: "mutation:cancelStream",
      conversationId: activeConversationId,
    });

    if (response.type === "error") {
      console.error("[miniBridge] cancelStream failed:", response.message);
    }
  }, [activeConversationId]);

  const events = useMemo(
    () => (snapshot.events as unknown as EventRecord[]),
    [snapshot.events],
  );

  useEffect(() => {
    if (!snapshotError) {
      return;
    }
  }, [snapshotError]);

  return {
    message,
    setMessage,
    streamingText: snapshot.streamingText,
    reasoningText: snapshot.reasoningText,
    isStreaming: snapshot.isStreaming || isLoadingSnapshot,
    pendingUserMessageId: snapshot.pendingUserMessageId,
    events,
    sendMessage,
    cancelStream,
  };
}


