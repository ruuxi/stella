import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useAction, useMutation } from "convex/react";
import type { UiState, UiStateUpdate } from "../types/ui";
import { useUiState } from "../app/state/ui-state";
import { ConversationEvents } from "./ConversationEvents";
import { api } from "../convex/api";
import { useConversationEvents, type EventRecord } from "../hooks/use-conversation-events";
import { getOrCreateDeviceId } from "../services/device";
import { getOwnerId } from "../services/identity";
import { streamChat } from "../services/model-gateway";
import { captureScreenshot } from "../services/screenshot";
import { ShiftingGradient } from "../components/background/ShiftingGradient";
import { ThemePicker } from "../components/ThemePicker";
import { useTheme } from "../theme/theme-context";
import { ScreenCommandBusProvider, useScreenCommandBus } from "./host/screen-command-bus";
import { ScreenIpcBridge } from "./host/ScreenIpcBridge";
import { getScreenDefinitions } from "./host/screen-registry";
import type { ScreenDefinition } from "./host/screen-types";

type AttachmentRef = {
  id?: string;
  url?: string;
  mimeType?: string;
};

const clamp = (value: number, min: number, max: number) => {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
};

type FullShellLayoutProps = {
  uiState: UiState;
  updateState: (partial: UiStateUpdate) => void;
  setWindow: (mode: "full" | "mini") => void;
  screens: ScreenDefinition[];
  activeScreenId: string;
  ensureActiveScreen: (screenId: string) => void;
  events: EventRecord[];
  streamingText: string;
  isStreaming: boolean;
  message: string;
  setMessage: (value: string) => void;
  sendMessage: () => Promise<void>;
};

const FullShellLayout = (props: FullShellLayoutProps) => {
  const {
    uiState,
    updateState,
    setWindow,
    screens,
    activeScreenId,
    ensureActiveScreen,
    events,
    streamingText,
    isStreaming,
    message,
    setMessage,
    sendMessage,
  } = props;
  const bus = useScreenCommandBus();
  const { gradientMode, gradientColor } = useTheme();

  const panelState = uiState.panel;
  const hasMessages = events.length > 0 || isStreaming;

  const MIN_PANEL_WIDTH = 320;
  const MIN_CHAT_WIDTH = 420;
  const COLLAPSED_CHAT_WIDTH = 78;

  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [panelWidth, setPanelWidth] = useState(panelState.width);
  const [isResizing, setIsResizing] = useState(false);
  const panelWidthRef = useRef(panelState.width);

  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (!isResizing) {
      panelWidthRef.current = panelState.width;
    }
  }, [isResizing, panelState.width]);

  useEffect(() => {
    panelWidthRef.current = panelWidth;
  }, [panelWidth]);

  const maxPanelWidth = Math.max(MIN_PANEL_WIDTH, viewportWidth - MIN_CHAT_WIDTH);

  useEffect(() => {
    if (!panelState.isOpen || panelState.focused || isResizing) {
      return;
    }
    const clamped = clamp(panelState.width, MIN_PANEL_WIDTH, maxPanelWidth);
    panelWidthRef.current = clamped;
    if (clamped !== panelState.width) {
      updateState({ panel: { width: clamped } });
    }
  }, [
    isResizing,
    maxPanelWidth,
    panelState.focused,
    panelState.isOpen,
    panelState.width,
    updateState,
  ]);

  useEffect(() => {
    if (!panelState.focused && panelState.chatDrawerOpen) {
      updateState({ panel: { chatDrawerOpen: false } });
    }
  }, [panelState.chatDrawerOpen, panelState.focused, updateState]);

  const panelWidthValue = isResizing ? panelWidth : panelState.width;

  const effectivePanelWidth = panelState.isOpen
    ? panelState.focused
      ? clamp(viewportWidth - COLLAPSED_CHAT_WIDTH, MIN_PANEL_WIDTH, viewportWidth)
      : clamp(panelWidthValue, MIN_PANEL_WIDTH, maxPanelWidth)
    : 0;

  const startXRef = useRef(0);
  const startWidthRef = useRef(panelState.width);

  const handleResizeMove = useCallback(
    (event: PointerEvent) => {
      const delta = startXRef.current - event.clientX;
      const nextWidth = clamp(startWidthRef.current + delta, MIN_PANEL_WIDTH, maxPanelWidth);
      panelWidthRef.current = nextWidth;
      setPanelWidth(nextWidth);
    },
    [maxPanelWidth],
  );

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!panelState.isOpen || panelState.focused) {
        return;
      }
      event.preventDefault();
      startXRef.current = event.clientX;
      startWidthRef.current = panelWidthRef.current;
      setIsResizing(true);
      setPanelWidth(panelWidthRef.current);

      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handleResizeMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        setIsResizing(false);
        updateState({ panel: { width: panelWidthRef.current } });
      };

      window.addEventListener("pointermove", handleResizeMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
      window.addEventListener("pointercancel", handlePointerUp, { once: true });
    },
    [handleResizeMove, panelState.focused, panelState.isOpen, setIsResizing, updateState],
  );

  const togglePanel = () => {
    const nextOpen = !panelState.isOpen;
    updateState({
      panel: {
        isOpen: nextOpen,
        focused: nextOpen ? panelState.focused : false,
        chatDrawerOpen: nextOpen ? panelState.chatDrawerOpen : false,
      },
    });
  };

  const toggleFocus = () => {
    const nextFocused = !panelState.focused;
    updateState({
      panel: {
        isOpen: true,
        focused: nextFocused,
        chatDrawerOpen: false,
      },
    });
  };

  const toggleChatDrawer = () => {
    updateState({ panel: { chatDrawerOpen: !panelState.chatDrawerOpen } });
  };

  const closeChatDrawer = () => updateState({ panel: { chatDrawerOpen: false } });

  const openAttachment = useCallback(
    (attachment: AttachmentRef) => {
      if (!attachment.url) {
        return;
      }
      void bus.invoke("media_viewer", "openMedia", {
        id: attachment.id,
        url: attachment.url,
        mimeType: attachment.mimeType,
        label: attachment.id ? `Attachment ${attachment.id}` : "Attachment",
      });
    },
    [bus],
  );

  const activeScreen = useMemo(
    () => screens.find((screen) => screen.id === activeScreenId) ?? screens[0] ?? null,
    [activeScreenId, screens],
  );
  const ActiveScreenComponent = activeScreen?.component ?? null;

  const renderChatPane = (containerClassName: string) => (
    <div className={containerClassName}>
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
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span>Ready to start</span>
            </div>
          </div>
        )}

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
              disabled={!uiState.conversationId}
            />
            <button
              className="primary-button composer-send"
              type="button"
              onClick={() => void sendMessage()}
              disabled={!uiState.conversationId || !message.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="window-shell full">
      <ShiftingGradient mode={gradientMode} colorMode={gradientColor} />

      <header className="window-header">
        <div className="header-title">
          <span className="app-badge">Stellar</span>
        </div>
        <div className="header-actions">
          <ThemePicker />
          <button className="ghost-button small" type="button" onClick={togglePanel}>
            {panelState.isOpen ? "Hide Panel" : "Show Panel"}
          </button>
          <button className="ghost-button small" type="button" onClick={() => setWindow("mini")}>
            Mini
          </button>
        </div>
      </header>

      <div className="full-body">
        <div
          className={`chat-column${panelState.focused ? " focused" : ""}`}
          style={panelState.focused ? { width: COLLAPSED_CHAT_WIDTH } : undefined}
        >
          {panelState.focused ? (
            <div className="chat-strip">
              <button className="ghost-button small chat-strip-button" onClick={toggleChatDrawer}>
                {panelState.chatDrawerOpen ? "Close Chat" : "Chat"}
              </button>
            </div>
          ) : (
            renderChatPane("chat-pane")
          )}

          {panelState.focused ? (
            <aside className={`chat-drawer${panelState.chatDrawerOpen ? " open" : ""}`}>
              <div className="chat-drawer-header">
                <div className="panel-title">Chat</div>
                <div className="panel-actions">
                  <button className="ghost-button small" type="button" onClick={closeChatDrawer}>
                    Close
                  </button>
                </div>
              </div>
              {renderChatPane("chat-pane drawer")}
            </aside>
          ) : null}
        </div>

        {panelState.isOpen ? (
          <aside className="right-panel" style={{ width: effectivePanelWidth }}>
            <div
              className="panel-resize-handle"
              onPointerDown={handleResizeStart}
              style={panelState.focused ? { display: "none" } : undefined}
            />

            <div className="right-panel-header">
              <div className="right-panel-tabs">
                {screens.map((screen) => (
                  <button
                    key={screen.id}
                    type="button"
                    className={`screen-tab${screen.id === activeScreenId ? " active" : ""}`}
                    onClick={() => ensureActiveScreen(screen.id)}
                  >
                    {screen.title}
                  </button>
                ))}
              </div>
              <div className="panel-actions">
                <button className="ghost-button small" type="button" onClick={toggleFocus}>
                  {panelState.focused ? "Unfocus" : "Focus"}
                </button>
              </div>
            </div>

            <div className="right-panel-body">
              {ActiveScreenComponent ? (
                <ActiveScreenComponent screenId={activeScreen.id} active />
              ) : (
                <div className="panel-hint">No screens registered.</div>
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
};

export const FullShell = () => {
  const { state, setConversationId, setWindow, updateState } = useUiState();
  const [message, setMessage] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(null);
  const appendEvent = useMutation(api.events.appendEvent);
  const createAttachment = useAction(api.attachments.createFromDataUrl);
  const createConversation = useMutation(api.conversations.createConversation);
  const events = useConversationEvents(state.conversationId ?? undefined);

  const isAskMode = state.mode === "ask";

  useEffect(() => {
    if (!state.conversationId) {
      void createConversation({ ownerId: getOwnerId() }).then(
        (conversation: { _id?: string } | null) => {
          if (conversation?._id) {
            setConversationId(conversation._id);
          }
        },
      );
    }
  }, [createConversation, setConversationId, state.conversationId]);

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
          (event.payload as { userMessageId?: string }).userMessageId === pendingUserMessageId
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
    if (!state.conversationId || !message.trim()) {
      return;
    }
    const deviceId = await getOrCreateDeviceId();
    const text = message.trim();
    setMessage("");

    let attachments: AttachmentRef[] = [];

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
          conversationId: state.conversationId,
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

  const screens = useMemo(() => getScreenDefinitions(), []);
  const defaultScreenId = screens[0]?.id ?? "media_viewer";
  const activeScreenId = screens.some((screen) => screen.id === state.panel.activeScreenId)
    ? state.panel.activeScreenId
    : defaultScreenId;

  useEffect(() => {
    if (state.panel.activeScreenId !== activeScreenId) {
      updateState({ panel: { activeScreenId } });
    }
  }, [activeScreenId, state.panel.activeScreenId, updateState]);

  const ensureActiveScreen = useCallback(
    (screenId: string) => {
      updateState({
        panel: {
          isOpen: true,
          activeScreenId: screenId,
        },
      });
    },
    [updateState],
  );

  return (
    <ScreenCommandBusProvider
      screens={screens}
      conversationId={state.conversationId}
      ensureActive={ensureActiveScreen}
    >
      <ScreenIpcBridge />
      <FullShellLayout
        uiState={state}
        updateState={updateState}
        setWindow={setWindow}
        screens={screens}
        activeScreenId={activeScreenId}
        ensureActiveScreen={ensureActiveScreen}
        events={events}
        streamingText={streamingText}
        isStreaming={isStreaming}
        message={message}
        setMessage={setMessage}
        sendMessage={sendMessage}
      />
    </ScreenCommandBusProvider>
  );
};
