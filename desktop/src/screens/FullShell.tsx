import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
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

type AttachmentRef = {
  id?: string;
  url?: string;
  mimeType?: string;
};

export const FullShell = () => {
  const { state, setConversationId, setWindow } = useUiState();
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

  const [panelOpen, setPanelOpen] = useState(true);
  const [panelFocused, setPanelFocused] = useState(false);
  const [panelWidth, setPanelWidth] = useState(360);
  const [activeMedia, setActiveMedia] = useState<MediaItem | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const resizeState = useRef({ startX: 0, startWidth: 360, active: false });

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

  useEffect(() => {
    if (!isResizing) {
      return;
    }
    const handleMove = (event: MouseEvent) => {
      const delta = event.clientX - resizeState.current.startX;
      const nextWidth = Math.min(
        720,
        Math.max(260, resizeState.current.startWidth - delta),
      );
      setPanelWidth(nextWidth);
    };

    const handleUp = () => {
      resizeState.current.active = false;
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing]);

  const onResizeStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!panelOpen || panelFocused) {
      return;
    }
    resizeState.current = {
      startX: event.clientX,
      startWidth: panelWidth,
      active: true,
    };
    setIsResizing(true);
  };

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
    const deviceId = getOrCreateDeviceId();
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
    setPanelOpen((prev) => {
      const next = !prev;
      if (!next) {
        setPanelFocused(false);
      }
      return next;
    });
  };

  return (
    <div className="window-shell full">
      <header className="window-header">
        <div className="header-title">
          <span className="app-badge">Stellar</span>
        </div>
        <div className="header-actions">
          <button className="ghost-button" type="button" onClick={togglePanel}>
            {panelOpen ? "Hide Media" : "Show Media"}
          </button>
          <button className="ghost-button" type="button" onClick={onNewConversation}>
            New conversation
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => setWindow("mini")}
          >
            Minimize
          </button>
        </div>
      </header>

      <div
        className={`full-body${panelFocused ? " focused" : ""}`}
        style={
          panelOpen
            ? ({ "--panel-width": `${panelWidth}px` } as CSSProperties)
            : undefined
        }
      >
        <section className="panel chat-panel">
          <div className="panel-content">
            {state.conversationId ? (
              <ConversationEvents
                events={events}
                streamingText={streamingText}
                isStreaming={isStreaming}
                onOpenAttachment={openAttachment}
              />
            ) : (
              <div className="event-empty">Starting conversation...</div>
            )}
            <div className="composer">
              <input
                className="composer-input"
                placeholder="Type a message..."
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void sendMessage();
                  }
                }}
                disabled={!state.conversationId}
              />
              <button
                className="primary-button"
                type="button"
                onClick={() => void sendMessage()}
                disabled={!state.conversationId}
              >
                Send
              </button>
            </div>
          </div>
        </section>

        {panelOpen ? (
          <aside className="panel side-panel">
            <div className="panel-resize-handle" onMouseDown={onResizeStart} />
            <div className="panel-header">
              <div className="panel-title">Media</div>
              <div className="panel-actions">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setPanelFocused((prev) => !prev)}
                >
                  {panelFocused ? "Unfocus" : "Focus"}
                </button>
                <button className="ghost-button" type="button" onClick={togglePanel}>
                  Close
                </button>
              </div>
            </div>
            <div className="panel-content">
              <MediaViewer item={activeMedia} onClear={() => setActiveMedia(null)} />
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
};
