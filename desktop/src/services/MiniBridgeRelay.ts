import { useEffect, useMemo, useRef } from "react";
import type { EventRecord } from "../../hooks/use-conversation-events";
import type { SendMessageArgs } from "../../hooks/use-streaming-chat";
import type {
  MiniBridgeRequestEnvelope,
  MiniBridgeResponse,
  MiniBridgeSnapshot,
} from "../../types/electron";

type MiniBridgeRelayProps = {
  conversationId: string | null;
  events: EventRecord[];
  streamingText: string;
  reasoningText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null;
  sendMessage: (args: SendMessageArgs) => Promise<void>;
};

const toSnapshot = (
  props: Omit<MiniBridgeRelayProps, "sendMessage">,
): MiniBridgeSnapshot => ({
  conversationId: props.conversationId,
  events: props.events as unknown as MiniBridgeSnapshot["events"],
  streamingText: props.streamingText,
  reasoningText: props.reasoningText,
  isStreaming: props.isStreaming,
  pendingUserMessageId: props.pendingUserMessageId,
});

const toErrorResponse = (message: string): MiniBridgeResponse => ({
  type: "error",
  message,
});

export function MiniBridgeRelay({
  conversationId,
  events,
  streamingText,
  reasoningText,
  isStreaming,
  pendingUserMessageId,
  sendMessage,
}: MiniBridgeRelayProps) {
  const snapshot = useMemo(
    () =>
      toSnapshot({
        conversationId,
        events,
        streamingText,
        reasoningText,
        isStreaming,
        pendingUserMessageId,
      }),
    [
      conversationId,
      events,
      streamingText,
      reasoningText,
      isStreaming,
      pendingUserMessageId,
    ],
  );

  const snapshotRef = useRef(snapshot);
  const sendMessageRef = useRef(sendMessage);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  useEffect(() => {
    window.electronAPI?.mini.pushUpdate?.({
      type: "snapshot",
      snapshot,
    });
  }, [snapshot]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.mini.onRequest || !api.mini.respond) {
      return;
    }

    const reply = (requestId: string, response: MiniBridgeResponse) => {
      api.mini.respond({ requestId, response });
    };

    const handleRequest = async (envelope: MiniBridgeRequestEnvelope) => {
      const requestId =
        typeof envelope?.requestId === "string" ? envelope.requestId : "";
      if (!requestId) {
        return;
      }

      const { request } = envelope;
      if (request.type === "query:snapshot") {
        reply(requestId, {
          type: "query:snapshot",
          snapshot: snapshotRef.current,
        });
        return;
      }

      if (request.type !== "mutation:sendMessage") {
        reply(requestId, toErrorResponse("Unsupported bridge request"));
        return;
      }

      const activeConversationId = snapshotRef.current.conversationId;
      if (!activeConversationId || request.conversationId !== activeConversationId) {
        reply(
          requestId,
          toErrorResponse("Conversation mismatch between mini and full windows"),
        );
        return;
      }

      try {
        await sendMessageRef.current({
          text: request.text,
          selectedText: request.selectedText,
          chatContext: request.chatContext,
          onClear: () => {},
        });
        reply(requestId, { type: "mutation:sendMessage", accepted: true });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to send message";
        reply(requestId, toErrorResponse(message));
      }
    };

    const unsubscribe = api.mini.onRequest(handleRequest);
    api.mini.ready?.();
    return unsubscribe;
  }, []);

  return null;
}
