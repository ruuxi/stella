import { useEffect, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { useUiState } from "../app/state/ui-state";
import { AsciiBlackHole } from "../components/AsciiBlackHole";
import { ConversationEvents } from "./ConversationEvents";
import { api } from "../convex/api";
import { useConversationEvents } from "../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../services/device";
import { streamChat } from "../services/model-gateway";
import { captureScreenshot } from "../services/screenshot";

export const MiniShell = () => {
  const { state, setConversationId, setWindow } = useUiState();
  const [message, setMessage] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [reasoningText, setReasoningText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(
    null,
  );
  const appendEvent = useMutation(api.events.appendEvent);
  const createAttachment = useAction(api.attachments.createFromDataUrl);
  const createConversation = useMutation(api.conversations.createConversation);
  const events = useConversationEvents(state.conversationId ?? undefined);

  // Mode is set by the radial menu selection
  const isAskMode = state.mode === "ask";

  // Auto-create conversation if none exists
  useEffect(() => {
    if (!state.conversationId) {
      void createConversation({}).then(
        (conversation: { _id?: string } | null) => {
          if (conversation?._id) {
            setConversationId(conversation._id);
          }
        },
      );
    }
  }, [state.conversationId, createConversation, setConversationId]);

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
      setReasoningText("");
      setIsStreaming(false);
      setPendingUserMessageId(null);
    }
  }, [events, pendingUserMessageId]);

  const sendMessage = async () => {
    if (!state.conversationId || !message.trim()) {
      return;
    }
    const deviceId = await getOrCreateDeviceId();
    const text = message.trim();
    setMessage("");

    let attachments: Array<{ id?: string; url?: string; mimeType?: string }> = [];

    // In Ask mode, capture screenshot automatically
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

    const platform = window.electronAPI?.platform ?? "unknown";
    const event = await appendEvent({
      conversationId: state.conversationId,
      type: "user_message",
      deviceId,
      payload: { text, attachments, platform },
    });

    if (event?._id) {
      setStreamingText("");
      setReasoningText("");
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
          onReasoningDelta: (delta) => {
            setReasoningText((prev) => prev + delta);
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

  const hasConversation = events.length > 0 || streamingText;

  return (
    <div className="raycast-shell">
      {/* Raycast-style unified panel - no gradient, solid panel */}
      <div className="raycast-panel">
        {/* Search bar header */}
        <div className="raycast-header">
          <div className="raycast-search">
            <div className="raycast-search-icon">
              <AsciiBlackHole width={32} height={32} />
            </div>
            <input
              className="raycast-input"
              placeholder={isAskMode ? "Ask about your screen..." : "Search for apps and commands..."}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              if (event.key === "Escape") {
                // Hide the mini shell window
                window.electronAPI?.closeWindow?.();
              }
              }}
              autoFocus
            />
            <div className="raycast-actions">
              <button
                className="raycast-action-button"
                type="button"
                onClick={() => setWindow("full")}
                title="Expand to full view"
              >
                <span className="raycast-action-label">Expand</span>
                <kbd className="raycast-kbd">Tab</kbd>
              </button>
            </div>
          </div>
        </div>

        {/* Results/conversation area */}
        {hasConversation && (
          <>
            <div className="raycast-results">
              <div className="raycast-section">
                <div className="raycast-section-header">Conversation</div>
                <div className="raycast-conversation-content">
                  <ConversationEvents
                    events={events}
                    maxItems={5}
                    streamingText={streamingText}
                    reasoningText={reasoningText}
                    isStreaming={isStreaming}
                  />
                </div>
              </div>
            </div>

            {/* Footer hint - only when conversation exists */}
            <div className="raycast-footer">
              <div className="raycast-footer-hint">
                <kbd className="raycast-kbd-small">Enter</kbd>
                <span>to send</span>
              </div>
              <div className="raycast-footer-hint">
                <kbd className="raycast-kbd-small">Esc</kbd>
                <span>to close</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
