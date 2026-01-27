import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { useUiState } from "../app/state/ui-state";
import { ConversationEvents } from "./ConversationEvents";
import { api } from "../convex/api";
import { useConversationEvents } from "../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../services/device";
import { getOwnerId } from "../services/identity";
import { streamChat } from "../services/model-gateway";
import { getElectronApi } from "../services/electron";
import type { UiMode } from "../types/ui";

const modes: UiMode[] = ["ask", "chat", "voice"];

const modeCopy: Record<UiMode, string> = {
  ask: "Ask includes a screenshot (no OCR).",
  chat: "Chat is text-only.",
  voice: "Voice uses speech-to-text.",
};

export const FullShell = () => {
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
  const createConversation = useMutation(api.conversations.createConversation);
  const events = useConversationEvents(state.conversationId ?? undefined);
  const isChatMode = state.mode === "chat";

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

  const sendMessage = () => {
    if (!isChatMode || !state.conversationId || !message.trim()) {
      return;
    }
    const deviceId = getOrCreateDeviceId();
    void appendEvent({
      conversationId: state.conversationId,
      type: "user_message",
      deviceId,
      payload: { text: message.trim() },
    }).then((event: { _id?: string } | null) => {
      if (event?._id) {
        setStreamingText("");
        setIsStreaming(true);
        setPendingUserMessageId(event._id);
        void streamChat(
          {
            conversationId: state.conversationId!,
            userMessageId: event._id,
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
    });
    setMessage("");
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
    <div className="window-shell full">
      <header className="window-header">
        <div className="header-title">
          <span className="app-badge">Stellar</span>
          <div className="header-subtitle">Full workspace</div>
          <div className="host-status">{hostStatus}</div>
        </div>
        <div className="header-actions">
          <div className="mode-toggle" role="tablist" aria-label="Assistant mode">
            {modes.map((mode) => (
              <button
                key={mode}
                type="button"
                data-active={state.mode === mode}
                onClick={() => setMode(mode)}
              >
                {mode.toUpperCase()}
              </button>
            ))}
          </div>
          <button className="ghost-button" type="button" onClick={onNewConversation}>
            New thread
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => setWindow("mini")}
          >
            Collapse to Mini
          </button>
        </div>
      </header>

      <div className="full-body">
        <section className="panel chat-panel">
          <div className="panel-header">
            <div className="panel-title">Chat workspace</div>
            <div className="panel-meta">
              {state.conversationId ?? "No conversation selected"}
            </div>
          </div>
          <div className="panel-content">
            <p className="panel-hint">
              {modeCopy[state.mode]}
              {!isChatMode ? " Switch to Chat to send messages." : ""}
            </p>
            {state.conversationId ? (
              <ConversationEvents
                events={events}
                streamingText={isChatMode ? streamingText : undefined}
                isStreaming={isChatMode ? isStreaming : false}
              />
            ) : (
              <div className="event-empty">Loading conversation...</div>
            )}
            <div className="composer">
              <input
                className="composer-input"
                placeholder="Compose a message or command..."
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    sendMessage();
                  }
                }}
                disabled={!state.conversationId || !isChatMode}
              />
              <button
                className="primary-button"
                type="button"
                onClick={sendMessage}
                disabled={!state.conversationId || !isChatMode}
              >
                Send
              </button>
            </div>
          </div>
        </section>

        <aside className="panel side-panel">
          <div className="panel-header">
            <div className="panel-title">Screens & context</div>
            <div className="panel-meta">Right panel</div>
          </div>
          <div className="panel-content">
            <div className="screen-card">
              <div className="screen-title">Active screen feed</div>
              <div className="screen-placeholder">
                Screens, captures, and tools land here.
              </div>
            </div>
            <div className="screen-card">
              <div className="screen-title">Agent status</div>
              <div className="screen-placeholder">
                General & Self-Modification agent queues.
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
