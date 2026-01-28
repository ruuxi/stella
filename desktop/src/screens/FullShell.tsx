import {
  useEffect,
  useState,
} from "react";
import { useAction, useMutation } from "convex/react";
import { useUiState } from "../app/state/ui-state";
import { ConversationEvents } from "./ConversationEvents";
import { MediaViewer, type MediaItem } from "./MediaViewer";
import { api } from "../convex/api";
import { useConversationEvents } from "../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../services/device";
import { getOwnerId } from "../services/identity";
import { streamChat } from "../services/model-gateway";
import { captureScreenshot } from "../services/screenshot";
import { ShiftingGradient } from "../components/background/ShiftingGradient";
import { ThemePicker } from "../components/ThemePicker";
import { useTheme } from "../theme/theme-context";

type AttachmentRef = {
  id?: string;
  url?: string;
  mimeType?: string;
};

export const FullShell = () => {
  const { state, setConversationId, setWindow } = useUiState();
  const { gradientMode, gradientColor } = useTheme();
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

  // Full view is always chat mode (no screenshot)
  const isAskMode = state.mode === "ask";

  const [panelOpen, setPanelOpen] = useState(false);
  const [activeMedia, setActiveMedia] = useState<MediaItem | null>(null);

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

  const openAttachment = (attachment: AttachmentRef) => {
    if (!attachment.url) {
      return;
    }
    setActiveMedia({
      id: attachment.id,
      url: attachment.url,
      mimeType: attachment.mimeType,
      label: attachment.id ? `Attachment ${attachment.id}` : "Attachment",
    });
    setPanelOpen(true);
  };

  const sendMessage = async () => {
    if (!state.conversationId || !message.trim()) {
      return;
    }
    const deviceId = await getOrCreateDeviceId();
    const text = message.trim();
    setMessage("");

    let attachments: AttachmentRef[] = [];

    // In Ask mode, capture screenshot
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

  const togglePanel = () => {
    setPanelOpen((prev) => !prev);
  };

  const hasMessages = events.length > 0 || isStreaming;

  return (
    <div className="window-shell full">
      <ShiftingGradient mode={gradientMode} colorMode={gradientColor} />

      {/* Header - minimal, floating */}
      <header className="window-header">
        <div className="header-title">
          <span className="app-badge">Stellar</span>
        </div>
        <div className="header-actions">
          <ThemePicker />
          <button className="ghost-button small" type="button" onClick={togglePanel}>
            {panelOpen ? "Close" : "Media"}
          </button>
          <button
            className="ghost-button small"
            type="button"
            onClick={() => setWindow("mini")}
          >
            Mini
          </button>
        </div>
      </header>

      {/* Main content area - full screen with gradient visible */}
      <div className="full-body">
        <div className="session-content">
          {hasMessages ? (
            <div className="session-messages">
              <ConversationEvents
                events={events}
                streamingText={streamingText}
                isStreaming={isStreaming}
                onOpenAttachment={openAttachment}
              />
            </div>
          ) : (
            <div className="new-session-view">
              <div className="new-session-title">New session</div>
              <div className="new-session-directory">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span>Ready to start</span>
              </div>
            </div>
          )}
        </div>

        {/* Composer - fixed at bottom */}
        <div className="composer">
          <div className="composer-wrapper">
            <input
              className="composer-input"
              placeholder="Type a message..."
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              disabled={!state.conversationId}
            />
            <button
              className="primary-button composer-send"
              type="button"
              onClick={() => void sendMessage()}
              disabled={!state.conversationId || !message.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Media panel - overlay style */}
      <aside className={`side-panel${panelOpen ? " open" : ""}`} style={{ transform: panelOpen ? "translateX(0)" : "translateX(100%)" }}>
        <div className="panel-header">
          <div className="panel-title">Media</div>
          <div className="panel-actions">
            <button className="ghost-button small" type="button" onClick={togglePanel}>
              Close
            </button>
          </div>
        </div>
        <div className="panel-content">
          <MediaViewer item={activeMedia} onClear={() => setActiveMedia(null)} />
        </div>
      </aside>
    </div>
  );
};
