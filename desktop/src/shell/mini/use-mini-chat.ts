import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { deriveComposerState } from "@/app/chat/composer-context";
import { useUiState } from "@/context/ui-state";
import { useIpcQuery } from "@/shared/hooks/use-ipc-query";
import type {
  ChatContext,
  MiniBridgeResponse,
  MiniBridgeSnapshot,
} from "@/shared/types/electron";
import type { EventRecord } from "@/app/chat/lib/event-transforms";

const createEmptySnapshot = (conversationId: string | null): MiniBridgeSnapshot => ({
  conversationId,
  events: [],
  streamingText: "",
  reasoningText: "",
  isStreaming: false,
  pendingUserMessageId: null,
});

function selectSnapshot(response: MiniBridgeResponse): MiniBridgeSnapshot {
  switch (response.type) {
    case "query:snapshot":
      return response.snapshot;
    case "mutation:sendMessage":
    case "mutation:cancelStream":
    case "error":
      throw new Error(`Unexpected mini snapshot response: ${response.type}`);
    default:
      throw new Error("Unexpected mini snapshot response");
  }
}

type UseMiniChatOptions = {
  isActive: boolean;
  chatContext: ChatContext | null;
  selectedText: string | null;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
  setSelectedText: Dispatch<SetStateAction<string | null>>;
};

export function useMiniChat({
  isActive,
  chatContext,
  selectedText,
  setChatContext,
  setSelectedText,
}: UseMiniChatOptions) {
  const { state } = useUiState();
  const activeConversationId = state.conversationId;

  const [message, setMessage] = useState("");
  const [liveSnapshot, setLiveSnapshot] = useState<MiniBridgeSnapshot | null>(null);
  const snapshotRequest = useMemo(
    () => ({
      type: "query:snapshot" as const,
      conversationId: activeConversationId,
    }),
    [activeConversationId],
  );

  const {
    data: initialSnapshot,
    loading: isLoadingSnapshot,
    refetch,
  } = useIpcQuery<MiniBridgeSnapshot>({
    enabled: isActive,
    request: snapshotRequest,
    select: selectSnapshot,
  });

  const snapshot = useMemo(() => {
    if (liveSnapshot?.conversationId === activeConversationId) {
      return liveSnapshot;
    }

    if (initialSnapshot?.conversationId === activeConversationId) {
      return initialSnapshot;
    }

    return createEmptySnapshot(activeConversationId);
  }, [activeConversationId, initialSnapshot, liveSnapshot]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const api = window.electronAPI;
    if (!api) {
      return;
    }

    return api.mini.onUpdate((update) => {
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
  }, [activeConversationId, isActive]);

  const sendMessage = useCallback(async () => {
    const api = window.electronAPI;
    const { canSubmit } = deriveComposerState({
      message,
      chatContext,
      selectedText,
      conversationId: activeConversationId,
      requireConversationId: true,
    });

    if (!api || !activeConversationId || !canSubmit) {
      return;
    }

    const response = await api.mini.request({
      type: "mutation:sendMessage",
      conversationId: activeConversationId,
      text: message,
      selectedText,
      chatContext,
    });

    switch (response.type) {
      case "error":
        console.error("[miniBridge] sendMessage failed:", response.message);
        return;
      case "mutation:sendMessage":
        if (!response.accepted) {
          return;
        }
        setMessage("");
        setSelectedText(null);
        setChatContext(null);
        void refetch();
        return;
      case "query:snapshot":
      case "mutation:cancelStream":
        throw new Error(`Unexpected mini bridge response: ${response.type}`);
      default:
        throw new Error("Unexpected mini bridge response");
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
    const api = window.electronAPI;
    if (!api || !activeConversationId) {
      return;
    }

    const response = await api.mini.request({
      type: "mutation:cancelStream",
      conversationId: activeConversationId,
    });

    switch (response.type) {
      case "error":
        console.error("[miniBridge] cancelStream failed:", response.message);
        return;
      case "mutation:cancelStream":
        return;
      case "query:snapshot":
      case "mutation:sendMessage":
        throw new Error(`Unexpected mini bridge response: ${response.type}`);
      default:
        throw new Error("Unexpected mini bridge response");
    }
  }, [activeConversationId]);

  const events = snapshot.events as EventRecord[];

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
