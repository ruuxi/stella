import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUiState } from "@/providers/ui-state";
import { useIpcQuery } from "@/hooks/use-ipc-query";
import type {
  ChatContext,
  MiniBridgeResponse,
  MiniBridgeSnapshot,
} from "@/types/electron";
import type { EventRecord } from "@/hooks/use-conversation-events";

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

  const [message, setMessage] = useState("");
  const [snapshot, setSnapshot] = useState<MiniBridgeSnapshot>(() =>
    createEmptySnapshot(activeConversationId ?? null),
  );
  const receivedLiveSnapshotRef = useRef(false);
  const snapshotRequest = useMemo(
    () => ({
      type: "query:snapshot" as const,
      conversationId: activeConversationId ?? null,
    }),
    [activeConversationId],
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

  useEffect(() => {
    setSnapshot((prev) => {
      const nextConversationId = activeConversationId ?? null;
      if (prev.conversationId === nextConversationId) {
        return prev;
      }
      return createEmptySnapshot(nextConversationId);
    });
    receivedLiveSnapshotRef.current = false;
  }, [activeConversationId]);

  useEffect(() => {
    if (!initialSnapshot) {
      return;
    }

    // Avoid clobbering fresher bridge updates with an older query response.
    if (receivedLiveSnapshotRef.current) {
      return;
    }

    setSnapshot(initialSnapshot);
  }, [initialSnapshot]);

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

      receivedLiveSnapshotRef.current = true;
      setSnapshot(update.snapshot);
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
  };
}


