import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { PanelRight, Pin } from "@/ui/icons";
import "./index.css";
import "./ui/register-styles";
import "./shared/styles/app-base.css";
import "./shared/i18n/rtl.css";
import "./mini-entry.css";
import { applyLowPowerDocumentFlag } from "./shared/lib/device-perf";

import { LocalChatStoreProvider } from "./context/chat-store-context";
import { ThemeProvider, useTheme } from "./context/theme-context";
import { ShiftingGradient } from "./shell/background/ShiftingGradient";
import { UiStateProvider } from "./context/ui-state";
import { BootstrapStateProvider } from "./bootstrap/bootstrap-state";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { ChatPanelTab, type ChatPanelOpenRequest } from "./shell/ChatSidebar";
import { ToastProvider } from "./ui/toast";
import { LocalI18nProvider, useLocale } from "./shared/i18n/I18nProvider";
import {
  readActiveConversationIdCache,
  writeActiveConversationIdCache,
} from "./features/chat/services/active-conversation-cache";
import {
  createNewLocalConversationId,
  setActiveLocalConversationId,
} from "./features/chat/services/local-chat-store";
import { useConversationActivity } from "./features/chat/hooks/use-conversation-activity";
import { useConversationDisplayMessages } from "./features/chat/hooks/use-conversation-display-messages";
import { useConversationMessages } from "./features/chat/hooks/use-conversation-messages";
import { useStreamingChatCore } from "./features/chat/hooks/use-streaming-chat-core";

applyLowPowerDocumentFlag();
document.documentElement.dataset.stellaWindow = "mini";

const noopNotifyTierRestrictedModel = () => {};
type MiniDisplayModule = typeof import("./mini-display/MiniDisplayFeature");
type IdleCallbackHandle = number;
type IdleDeadline = {
  readonly didTimeout: boolean;
  timeRemaining(): number;
};
type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadline) => void,
    options?: { timeout?: number },
  ) => IdleCallbackHandle;
  cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
};

const MAX_QUEUED_DISPLAY_PAYLOADS = 20;
let miniDisplayModulePromise: Promise<MiniDisplayModule> | null = null;

function loadMiniDisplayModule(): Promise<MiniDisplayModule> {
  miniDisplayModulePromise ??= import("./mini-display/MiniDisplayFeature");
  return miniDisplayModulePromise;
}

function MiniWindowTopBar({
  latestRawPayloadRef,
  miniDisplayModule,
  onOpenWorkspacePanel,
}: {
  latestRawPayloadRef: RefObject<unknown | null>;
  miniDisplayModule: MiniDisplayModule | null;
  onOpenWorkspacePanel: () => void;
}) {
  const [miniAlwaysOnTop, setMiniAlwaysOnTopState] = useState(true);
  const MiniDisplayTabBar = miniDisplayModule?.MiniDisplayTabBar;
  const MiniDisplayWorkspaceButton =
    miniDisplayModule?.MiniDisplayWorkspaceButton;

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

  return (
    <header className="mini-window-topbar">
      <div className="mini-window-topbar__drag" aria-hidden="true" />
      {MiniDisplayTabBar ? <MiniDisplayTabBar /> : null}
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
        {MiniDisplayWorkspaceButton ? (
          <MiniDisplayWorkspaceButton
            latestRawPayloadRef={latestRawPayloadRef}
          />
        ) : (
          <button
            type="button"
            className="mini-window-topbar__button"
            onClick={onOpenWorkspacePanel}
            aria-label="Open workspace panel"
            title="Open workspace panel"
          >
            <PanelRight size={14} strokeWidth={1.75} />
          </button>
        )}
      </div>
    </header>
  );
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
  const [miniDisplayModule, setMiniDisplayModule] =
    useState<MiniDisplayModule | null>(null);
  const miniDisplayModuleRef = useRef<MiniDisplayModule | null>(null);
  const latestDisplayRawPayloadRef = useRef<unknown | null>(null);
  const queuedDisplayRawPayloadsRef = useRef<unknown[]>([]);

  const drainQueuedDisplayPayloads = useCallback(
    (module: MiniDisplayModule) => {
      const queuedPayloads = queuedDisplayRawPayloadsRef.current.splice(0);
      for (const rawPayload of queuedPayloads) {
        module.routeMiniDisplayPayload(rawPayload, {
          activate: true,
          openPanel: false,
        });
      }
    },
    [],
  );

  const markMiniDisplayModuleReady = useCallback(
    (module: MiniDisplayModule) => {
      miniDisplayModuleRef.current = module;
      setMiniDisplayModule(module);
      drainQueuedDisplayPayloads(module);
    },
    [drainQueuedDisplayPayloads],
  );

  const ensureMiniDisplayModule = useCallback(async () => {
    const existingModule = miniDisplayModuleRef.current;
    if (existingModule) return existingModule;
    const module = await loadMiniDisplayModule();
    markMiniDisplayModuleReady(module);
    return module;
  }, [markMiniDisplayModuleReady]);

  useEffect(() => {
    return window.electronAPI?.display.onUpdate((rawPayload) => {
      latestDisplayRawPayloadRef.current = rawPayload;
      const module = miniDisplayModuleRef.current;
      if (module) {
        module.routeMiniDisplayPayload(rawPayload, {
          activate: true,
          openPanel: false,
        });
        return;
      }

      queuedDisplayRawPayloadsRef.current.push(rawPayload);
      if (
        queuedDisplayRawPayloadsRef.current.length > MAX_QUEUED_DISPLAY_PAYLOADS
      ) {
        queuedDisplayRawPayloadsRef.current.splice(
          0,
          queuedDisplayRawPayloadsRef.current.length -
            MAX_QUEUED_DISPLAY_PAYLOADS,
        );
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let frameId: number | null = null;
    let timerId: number | null = null;
    let idleId: IdleCallbackHandle | null = null;
    const idleWindow = window as WindowWithIdleCallback;

    const preload = () => {
      void loadMiniDisplayModule().then((module) => {
        if (cancelled) return;
        markMiniDisplayModuleReady(module);
      });
    };

    frameId = window.requestAnimationFrame(() => {
      timerId = window.setTimeout(() => {
        timerId = null;
        if (idleWindow.requestIdleCallback) {
          idleId = idleWindow.requestIdleCallback(
            () => {
              idleId = null;
              preload();
            },
            { timeout: 1500 },
          );
          return;
        }
        preload();
      }, 300);
    });

    return () => {
      cancelled = true;
      if (frameId != null) window.cancelAnimationFrame(frameId);
      if (timerId != null) window.clearTimeout(timerId);
      if (idleId != null) idleWindow.cancelIdleCallback?.(idleId);
    };
  }, [markMiniDisplayModuleReady]);

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

  const { activities, latestMessageTimestampMs } = useConversationActivity(
    conversationId ?? undefined,
  );

  const {
    liveTasks,
    optimisticEvents,
    runtimeStatusText,
    activeRunId,
    activeToolCallId,
    activeToolName,
    hasToolActivity,
    isToolActive,
    streamingAssistants,
    isStreaming,
    isStreamingResponseText,
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
      void ensureMiniDisplayModule().then((module) => {
        module.toggleMiniWorkspacePanel(latestDisplayRawPayloadRef.current);
      });
    },
    [ensureMiniDisplayModule],
  );
  const handleOpenWorkspacePanel = useCallback(() => {
    void ensureMiniDisplayModule().then((module) => {
      module.openMiniWorkspacePanel(latestDisplayRawPayloadRef.current);
    });
  }, [ensureMiniDisplayModule]);
  const MiniDisplayPanelHost = miniDisplayModule?.MiniDisplayPanelHost;

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
          latestRawPayloadRef={latestDisplayRawPayloadRef}
          miniDisplayModule={miniDisplayModule}
          onOpenWorkspacePanel={handleOpenWorkspacePanel}
        />
        <div ref={setDisplayPortalTarget} className="mini-chat-body full-body">
          <div className="mini-chat-content">
            <ChatPanelTab
              openRequest={composerFocusRequest}
              conversationId={conversationId}
              variant="mini"
              messages={messages}
              activities={activities}
              latestMessageTimestampMs={latestMessageTimestampMs}
              isStreaming={isStreaming}
              isStreamingResponseText={isStreamingResponseText}
              runtimeStatusText={runtimeStatusText}
              activeRunId={activeRunId}
              activeToolCallId={activeToolCallId}
              activeToolName={activeToolName}
              hasToolActivity={hasToolActivity}
              isToolActive={isToolActive}
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
          {MiniDisplayPanelHost ? (
            <MiniDisplayPanelHost portalTarget={displayPortalTarget} />
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
