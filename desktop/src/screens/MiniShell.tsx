import { useEffect, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { useUiState } from "../app/state/ui-state";
import { ConversationEvents } from "./ConversationEvents";
import { api } from "../convex/api";
import { useConversationEvents } from "../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../services/device";
import { getOwnerId } from "../services/identity";
import { streamChat } from "../services/model-gateway";
import { getElectronApi } from "../services/electron";
import { captureScreenshot } from "../services/screenshot";
import type { UiMode } from "../types/ui";

const modes: UiMode[] = ["ask", "chat", "voice"];

export const MiniShell = () => {
  const { state, setMode, setConversationId, setWindow } = useUiState();
  const hostStatus = getElectronApi()
    ? "Local Host connected"
    : "Local Host disconnected";
  const [message, setMessage] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(
    null,
  );
  const appendEvent = useMutation(api.events.appendEvent);
  const createAttachment = useAction(api.attachments.createFromDataUrl);
  const createConversation = useMutation(api.conversations.createConversation);
  const events = useConversationEvents(state.conversationId ?? undefined);
  const isChatMode = state.mode === "chat";
  const isAskMode = state.mode === "ask";
  const canSend = isChatMode || isAskMode;

  useEffect(() => {
    if (!pendingUserMessageId) {
      return;
    }
    const hasAssistantReply = events.some((event) => {
      if (event.type !== "assistant_message") {
        return false;
      }
      if (event.payload && typeof event.payload === "object") {
        return (
          (event.payload as { userMessageId?: string }).userMessageId ===
          pendingUserMessageId
        );
      }
      return false;
    });

    if (hasAssistantReply) {
      setStreamingText("");
      setIsStreaming(false);
      setPendingUserMessageId(null);
    }
  }, [events, pendingUserMessageId]);

  const sendMessage = async () => {
    if (!canSend || !state.conversationId || !message.trim()) {
      return;
    }
    const deviceId = getOrCreateDeviceId();
    const text = message.trim();
    setMessage("");

    let attachments: Array<{ id?: string; url?: string; mimeType?: string }> = [];

    if (isAskMode) {
      try {
        const screenshot = await captureScreenshot();
        if (!screenshot?.dataUrl) {
          throw new Error("Screenshot capture failed.");
        }
        const attachment = await createAttachment({
          conversationId: state.conversationId,
          deviceId,
          dataUrl: screenshot.dataUrl,
        });
        if (attachment?._id) {
          attachments = [
            {
              id: attachment._id as string,
              url: attachment.url,
              mimeType: attachment.mimeType,
            },
          ];
        }
      } catch (error) {
        console.error("Screenshot capture failed", error);
        return;
      }
    }

    const event = await appendEvent({
      conversationId: state.conversationId,
      type: "user_message",
      deviceId,
      payload: { text, attachments },
    });

    if (event?._id) {
      setStreamingText("");
      setIsStreaming(true);
      setPendingUserMessageId(event._id);
      void streamChat(
        {
          conversationId: state.conversationId!,
          userMessageId: event._id,
          attachments,
        },
        {
          onTextDelta: (delta) => {
            setStreamingText((prev) => prev + delta);
          },
          onDone: () => {
            setIsStreaming(false);
          },
          onError: (error) => {
            console.error("Model gateway error", error);
            setIsStreaming(false);
          },
        },
      ).catch((error) => {
        console.error("Model gateway error", error);
        setIsStreaming(false);
      });
    }
  };

  const onNewConversation = () => {
    void createConversation({ ownerId: getOwnerId() }).then(
      (conversation: { _id?: string } | null) => {
        if (conversation?._id) {
          setConversationId(conversation._id);
        }
      },
    );
  };

  return (
    <div className="window-shell mini">
      <div className="mini-top">
        <div className="header-title">
          <span className="app-badge">Stellar</span>
          <span className="header-subtitle">Mini prompt</span>
          <span className="host-status">{hostStatus}</span>
        </div>
        <div className="mode-toggle compact" role="tablist" aria-label="Assistant mode">
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              data-active={state.mode === mode}
              onClick={() => setMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={() => setWindow("full")}
        >
          Expand
        </button>
      </div>

      <div className="mini-input">
        <input
          className="composer-input"
          placeholder="Ask Stellar, search, or run a command..."
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void sendMessage();
            }
          }}
          disabled={!state.conversationId || !canSend}
        />
        <button
          className="ghost-button"
          type="button"
          onClick={() => void sendMessage()}
          disabled={!state.conversationId || !canSend}
        >
          Send
        </button>
      </div>

      <div className="mini-thread">
        <div className="panel-header">
          <div className="panel-title">Thread</div>
          <div className="panel-meta">
            {state.conversationId ?? "No conversation yet"}
          </div>
        </div>
        <div className="panel-content compact">
          {state.conversationId ? (
            <ConversationEvents
              events={events}
              maxItems={4}
              streamingText={canSend ? streamingText : undefined}
              isStreaming={canSend ? isStreaming : false}
            />
          ) : (
            <div className="event-empty">Loading conversation...</div>
          )}
          <button className="ghost-button" type="button" onClick={onNewConversation}>
            New thread
          </button>
        </div>
      </div>
    </div>
  );
};
