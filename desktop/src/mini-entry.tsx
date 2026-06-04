import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  Suspense,
} from "react";
import { PanelRight, Pin, X } from "lucide-react";
import "./index.css";
import "./ui/register-styles";
import "./shared/styles/app-base.css";
import "./shared/styles/app-components.css";
import "./shared/i18n/rtl.css";
import "./mini-entry.css";

import { LocalChatStoreProvider } from "./context/chat-store-context";
import { ThemeProvider, useTheme } from "./context/theme-context";
import { ShiftingGradient } from "./shell/background/ShiftingGradient";
import { UiStateProvider } from "./context/ui-state";
import { BootstrapStateProvider } from "./bootstrap/bootstrap-state";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { ChatPanelTab, type ChatPanelOpenRequest } from "./shell/ChatSidebar";
import { ToastProvider } from "./ui/toast";
import {
  LocalI18nProvider,
  useLocale,
} from "./shared/i18n/I18nProvider";
import { readActiveConversationIdCache, writeActiveConversationIdCache } from "./features/chat/services/active-conversation-cache";
import {
  createNewLocalConversationId,
  setActiveLocalConversationId,
} from "./features/chat/services/local-chat-store";
import { useConversationActivity } from "./features/chat/hooks/use-conversation-activity";
import { useConversationDisplayMessages } from "./features/chat/hooks/use-conversation-display-messages";
import { useConversationMessages } from "./features/chat/hooks/use-conversation-messages";
import { useStreamingChatCore } from "./features/chat/hooks/use-streaming-chat-core";
import {
  displayTabs,
  useDisplayTabList,
  useDisplayPanelOpen,
} from "./features/workspace-display/tab-store";
import {
  type DisplayTabPayload,
  normalizeDisplayPayload,
} from "./shared/contracts/display-payload";
import { DisplayTabIcon } from "./features/workspace-display/icons";
import "./shell/display/chat-home-overview.css";

document.documentElement.dataset.stellaWindow = "mini";

const noopNotifyTierRestrictedModel = () => {};
const MINI_HOME_DISPLAY_TAB_ID = "mini:home";

const LazyDisplaySidebar = lazy(() =>
  import("./shell/DisplaySidebar").then((module) => ({
    default: module.DisplaySidebar,
  })),
);

const openDisplayPayload = async (
  payload: DisplayTabPayload,
  opts?: Parameters<typeof displayTabs.openTab>[1],
) => {
  const { payloadToTabSpec } = await import("./shell/display/payload-to-tab-spec");
  displayTabs.openTab(payloadToTabSpec(payload), opts);
};

function MiniDisplayHomeTab() {
  return (
    <div className="chat-home-launcher">
      <ul className="chat-home-launcher__list">
        <li>
          <button
            type="button"
            className="chat-home-launcher__entry"
            onClick={() => {
              void openMiniCanvasDisplayTab();
            }}
          >
            <span className="chat-home-launcher__entry-icon" aria-hidden="true">
              <DisplayTabIcon kind="canvas" size={20} />
            </span>
            <span className="chat-home-launcher__entry-text">
              <span className="chat-home-launcher__entry-label">Canvas</span>
              <span className="chat-home-launcher__entry-description">
                Pages Stella has put together
              </span>
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="chat-home-launcher__entry"
            onClick={() => {
              void openMiniMediaDisplayTab();
            }}
          >
            <span className="chat-home-launcher__entry-icon" aria-hidden="true">
              <DisplayTabIcon kind="media" size={20} />
            </span>
            <span className="chat-home-launcher__entry-text">
              <span className="chat-home-launcher__entry-label">Media</span>
              <span className="chat-home-launcher__entry-description">
                Generated images, video, and audio
              </span>
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="chat-home-launcher__entry"
            onClick={() => {
              void openMiniTrashDisplayTab();
            }}
          >
            <span className="chat-home-launcher__entry-icon" aria-hidden="true">
              <DisplayTabIcon kind="trash" size={20} />
            </span>
            <span className="chat-home-launcher__entry-text">
              <span className="chat-home-launcher__entry-label">Trash</span>
              <span className="chat-home-launcher__entry-description">
                Things you've recently deleted
              </span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  );
}

function openMiniHomeDisplayTab(
  opts?: Parameters<typeof displayTabs.openTab>[1],
) {
  displayTabs.openTab(
    {
      id: MINI_HOME_DISPLAY_TAB_ID,
      kind: "home",
      title: "Home",
      tooltip: "Display sidebar home",
      render: () => <MiniDisplayHomeTab />,
    },
    opts,
  );
}

async function openMiniCanvasDisplayTab() {
  const [{ CanvasTabContent }, { getCanvasHtmlItems }] = await Promise.all([
    import("./shell/display/canvas-tab/CanvasTabContent"),
    import("./shell/display/canvas-tab/canvas-items"),
  ]);
  const items = getCanvasHtmlItems();
  displayTabs.openTab({
    id: "canvas:html",
    kind: "canvas",
    title: "Canvas",
    tooltip: "HTML canvases Stella has shown you",
    metadata: { kind: "canvas-html", items },
    render: () => <CanvasTabContent items={items} />,
  });
}

async function openMiniMediaDisplayTab() {
  const [{ MediaTabContent }, { getGeneratedMediaItems }] = await Promise.all([
    import("./shell/display/media-tab"),
    import("./shell/display/payload-to-tab-spec"),
  ]);
  const items = getGeneratedMediaItems();
  displayTabs.openTab({
    id: "media:generated",
    kind: "media",
    title: "Media",
    tooltip: "Generated media",
    metadata: { kind: "media", items },
    render: () => <MediaTabContent items={items} />,
  });
}

async function openMiniTrashDisplayTab() {
  const { TrashTabContent } = await import("./shell/display/TrashTabContent");
  displayTabs.openTab({
    id: "trash:deferred-delete",
    kind: "trash",
    title: "Trash",
    render: () => <TrashTabContent />,
  });
}

function openMiniWorkspacePanel(
  latestDisplayPayloadRef: RefObject<DisplayTabPayload | null>,
) {
  if (displayTabs.getSnapshot().tabs.length > 0) {
    displayTabs.setPanelOpen(true);
    return;
  }

  const latestPayload = latestDisplayPayloadRef.current;
  if (latestPayload) {
    void openDisplayPayload(latestPayload);
    return;
  }

  openMiniHomeDisplayTab();
}

function toggleMiniWorkspacePanel(
  latestDisplayPayloadRef: RefObject<DisplayTabPayload | null>,
) {
  if (displayTabs.getSnapshot().panelOpen) {
    displayTabs.setPanelOpen(false);
    return;
  }
  openMiniWorkspacePanel(latestDisplayPayloadRef);
}

function MiniDisplayTabBar() {
  const { tabs, activeTabId } = useDisplayTabList();
  if (tabs.length === 0) return null;

  return (
    <div className="mini-window-topbar__tabs" role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const title = tab.id === MINI_HOME_DISPLAY_TAB_ID ? "Home" : tab.title;
        return (
          <div
            key={tab.id}
            className={`mini-display-tab${
              isActive ? " mini-display-tab--active" : ""
            }`}
            role="tab"
            aria-selected={isActive}
            title={tab.tooltip ?? title}
          >
            <button
              type="button"
              className="mini-display-tab__button"
              onClick={() => displayTabs.activateTab(tab.id)}
            >
              <DisplayTabIcon kind={tab.kind} size={18} />
              <span className="mini-display-tab__title">{title}</span>
            </button>
            <button
              type="button"
              className="mini-display-tab__close"
              aria-label={`Close ${title}`}
              onClick={(event) => {
                event.stopPropagation();
                displayTabs.closeTab(tab.id);
              }}
            >
              <X size={11} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function MiniWindowTopBar({
  latestDisplayPayloadRef,
}: {
  latestDisplayPayloadRef: RefObject<DisplayTabPayload | null>;
}) {
  const panelOpen = useDisplayPanelOpen();
  const [miniAlwaysOnTop, setMiniAlwaysOnTopState] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.window.isMiniAlwaysOnTop?.().then((enabled) => {
      if (!cancelled) setMiniAlwaysOnTopState(Boolean(enabled));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleMiniAlwaysOnTop = useCallback(() => {
    const next = !miniAlwaysOnTop;
    setMiniAlwaysOnTopState(next);
    void window.electronAPI?.window
      .setMiniAlwaysOnTop?.(next)
      .then((actual) => setMiniAlwaysOnTopState(Boolean(actual)))
      .catch(() => setMiniAlwaysOnTopState(!next));
  }, [miniAlwaysOnTop]);

  const toggleWorkspacePanel = useCallback(() => {
    toggleMiniWorkspacePanel(latestDisplayPayloadRef);
  }, [latestDisplayPayloadRef]);

  return (
    <header
      className="mini-window-topbar"
      data-display-open={panelOpen ? "true" : undefined}
    >
      <div className="mini-window-topbar__drag" aria-hidden="true" />
      {panelOpen ? <MiniDisplayTabBar /> : null}
      <div className="mini-window-topbar__spacer" aria-hidden="true" />
      <div className="mini-window-topbar__actions">
        <button
          type="button"
          className="mini-window-topbar__button"
          onClick={toggleMiniAlwaysOnTop}
          aria-label={
            miniAlwaysOnTop
              ? "Disable always on top"
              : "Keep mini window on top"
          }
          aria-pressed={miniAlwaysOnTop}
          title={
            miniAlwaysOnTop
              ? "Disable always on top"
              : "Keep mini window on top"
          }
        >
          <Pin size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="mini-window-topbar__button"
          onClick={toggleWorkspacePanel}
          aria-label={
            panelOpen ? "Close workspace panel" : "Open workspace panel"
          }
          title={panelOpen ? "Close workspace panel" : "Open workspace panel"}
        >
          {panelOpen ? (
            <X size={15} strokeWidth={1.85} />
          ) : (
            <PanelRight size={14} strokeWidth={1.75} />
          )}
        </button>
      </div>
    </header>
  );
}

function useMiniDisplayPayloadRouting() {
  const latestDisplayPayloadRef = useRef<DisplayTabPayload | null>(null);

  useEffect(() => {
    return window.electronAPI?.display.onUpdate((rawPayload) => {
      const payload = normalizeDisplayPayload(rawPayload);
      if (!payload) return;
      latestDisplayPayloadRef.current = payload;
      void openDisplayPayload(payload, { activate: true, openPanel: false });
    });
  }, []);

  return latestDisplayPayloadRef;
}

function useMiniActiveConversationId() {
  const [conversationId, setConversationId] = useState<string | null>(() =>
    readActiveConversationIdCache(),
  );

  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI?.localChat;
    if (!api) return;

    void api
      .getOrCreateDefaultConversationId()
      .then((activeConversationId) => {
        if (cancelled || !activeConversationId) return;
        setConversationId(activeConversationId);
      })
      .catch(() => {
        if (!cancelled) setConversationId((current) => current ?? null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    writeActiveConversationIdCache(conversationId);
    void setActiveLocalConversationId(conversationId);
  }, [conversationId]);

  return { conversationId, setConversationId };
}

function MiniChatSurface() {
  const locale = useLocale();
  const { gradientMode, gradientColor } = useTheme();
  const { conversationId, setConversationId } = useMiniActiveConversationId();
  const [displayPortalTarget, setDisplayPortalTarget] =
    useState<HTMLDivElement | null>(null);
  const latestDisplayPayloadRef = useMiniDisplayPayloadRouting();
  const panelOpen = useDisplayPanelOpen();

  useEffect(() => {
    if (panelOpen) {
      document.documentElement.dataset.displayPanelOpen = "true";
      return;
    }
    delete document.documentElement.dataset.displayPanelOpen;
    return () => {
      delete document.documentElement.dataset.displayPanelOpen;
    };
  }, [panelOpen]);

  // Focus the composer each time the mini window opens / regains focus, so the
  // user can type immediately and focus never lands on the scrollable message
  // region (a keyboard-focusable scroller that would otherwise draw a
  // focus-ring "selected" border on open). Mirrors the full window, which
  // focuses the composer whenever chat opens.
  const [composerFocusRequest, setComposerFocusRequest] =
    useState<ChatPanelOpenRequest>({ id: 1 });
  useEffect(() => {
    const onFocus = () =>
      setComposerFocusRequest((prev) => ({ id: prev.id + 1 }));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const {
    messages: persistedMessages,
    hasOlderMessages,
    isLoadingOlder: isLoadingOlderMessages,
    isInitialLoading: isInitialLoadingMessages,
    loadOlder: loadOlderMessages,
  } = useConversationMessages(conversationId ?? undefined);

  const {
    activities,
    latestMessageTimestampMs,
  } = useConversationActivity(conversationId ?? undefined);

  const {
    liveTasks,
    optimisticEvents,
    runtimeStatusText,
    streamingAssistants,
    isStreaming,
    pendingUserMessageId,
    queuedUserMessages,
    sendMessage,
    cancelCurrentStream,
  } = useStreamingChatCore({
    conversationId,
    locale,
    notifyTierRestrictedModel: noopNotifyTierRestrictedModel,
    persistedMessages,
  });

  const displayMessages = useConversationDisplayMessages({
    conversationId,
    persistedMessages,
    optimisticEvents,
    streamingAssistants,
  });

  const startNewChat = useCallback(async () => {
    const nextConversationId = await createNewLocalConversationId();
    setConversationId(nextConversationId);
  }, [setConversationId]);

  const handleSend = useCallback(
    (
      text: string,
      chatContext?: Parameters<typeof sendMessage>[0]["chatContext"],
      selectedText?: string | null,
    ) => {
      void sendMessage({
        text,
        chatContext: chatContext ?? null,
        selectedText: selectedText ?? null,
        onClear: () => {},
      });
    },
    [sendMessage],
  );

  const loadingConversation = !conversationId || isInitialLoadingMessages;
  const messages = useMemo(
    () => (conversationId ? displayMessages : []),
    [conversationId, displayMessages],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      toggleMiniWorkspacePanel(latestDisplayPayloadRef);
    },
    [latestDisplayPayloadRef],
  );

  return (
    <div className="mini-chat-app">
      <div className="mini-chat-shell" onContextMenu={handleContextMenu}>
        <ShiftingGradient
          mode={gradientMode}
          colorMode={gradientColor}
          lightweight={false}
          contained
        />
        <MiniWindowTopBar
          latestDisplayPayloadRef={latestDisplayPayloadRef}
        />
        <div
          ref={setDisplayPortalTarget}
          className="mini-chat-body full-body"
          data-display-panel-open={panelOpen ? "true" : undefined}
        >
          <div className="mini-chat-content">
            <ChatPanelTab
              openRequest={composerFocusRequest}
              conversationId={conversationId}
              variant="mini"
              messages={messages}
              activities={activities}
              latestMessageTimestampMs={latestMessageTimestampMs}
              isStreaming={isStreaming}
              runtimeStatusText={runtimeStatusText}
              pendingUserMessageId={pendingUserMessageId}
              queuedUserMessages={queuedUserMessages}
              liveTasks={liveTasks}
              hasOlderMessages={hasOlderMessages}
              isLoadingOlder={isLoadingOlderMessages}
              isInitialLoading={loadingConversation}
              onLoadOlder={loadOlderMessages}
              onSend={handleSend}
              onStop={cancelCurrentStream}
              onNewChat={startNewChat}
            />
          </div>
          {panelOpen ? (
            <Suspense fallback={null}>
              <LazyDisplaySidebar portalTarget={displayPortalTarget} />
            </Suspense>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MiniRoot() {
  return (
    <ErrorBoundary>
      <LocalI18nProvider>
        <ThemeProvider>
          <ToastProvider>
            <BootstrapStateProvider>
              <UiStateProvider>
                <LocalChatStoreProvider>
                  <MiniChatSurface />
                </LocalChatStoreProvider>
              </UiStateProvider>
            </BootstrapStateProvider>
          </ToastProvider>
        </ThemeProvider>
      </LocalI18nProvider>
    </ErrorBoundary>
  );
}

createRoot(document.getElementById("root")!).render(<MiniRoot />);
