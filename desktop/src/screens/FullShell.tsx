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

import { AsciiBlackHole } from "../components/AsciiBlackHole";

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
            <div className="new-session-view" style={{ 
              width: '100%', 
              maxWidth: 'none', 
              padding: 0, 
              alignItems: 'center', 
              justifyContent: 'center', 
              overflow: 'hidden',
              position: 'relative'
            }}>
              <AsciiBlackHole width={120} height={56} />
              <div 
                className="new-session-title" 
                style={{ 
                  position: 'absolute', 
                  bottom: '15%', 
                  zIndex: 10,
                  opacity: 0.5,
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  fontSize: '12px',
                  mixBlendMode: 'plus-lighter'
                }}
              >
                Stellar
              </div>
            </div>
          )}
        </div>

        {/* Composer - Aura-style prompt bar at bottom */}
        <div className="composer">
          <form
            className="composer-form"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            {/* Input scroll container */}
            <div className="composer-scroll">
              <textarea
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
                rows={1}
              />
            </div>

            {/* Bottom toolbar */}
            <div className="composer-toolbar">
              <div className="composer-toolbar-left">
                {/* Placeholder for model/agent selector */}
                <button type="button" className="composer-selector">
                  <svg className="composer-selector-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4M12 8h.01" />
                  </svg>
                  <span>Model</span>
                </button>
              </div>

              <div className="composer-toolbar-right">
                {/* Placeholder action buttons */}
                <button type="button" className="composer-action" title="Attach file">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21,15 16,10 5,21" />
                  </svg>
                </button>

                {/* Submit button */}
                <button
                  type="submit"
                  className="composer-submit"
                  disabled={!state.conversationId || !message.trim()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </form>
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
