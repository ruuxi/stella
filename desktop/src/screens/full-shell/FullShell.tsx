/**
 * FullShell: Layout shell that imports sub-components, holds top-level state,
 * renders .full-body grid: Sidebar | WorkspaceArea | ChatPanel.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { useUiState } from "../../app/state/ui-state";
import { useWorkspace } from "../../app/state/workspace-state";
import { useTheme } from "../../theme/theme-context";
import { useConversationEvents } from "../../hooks/use-conversation-events";
import { useCanvasCommands } from "../../hooks/use-canvas-commands";
import { getElectronApi } from "../../services/electron";
import { secureSignOut } from "../../services/auth";
import { api } from "@/convex/api";
import { ShiftingGradient } from "../../components/background/ShiftingGradient";
import { TitleBar } from "../../components/TitleBar";
import { Sidebar } from "../../components/Sidebar";
import { WorkspaceArea } from "../../components/workspace/WorkspaceArea";
import { HeaderTabBar } from "../../components/header/HeaderTabBar";
import { FloatingOrb } from "../../components/orb/FloatingOrb";
import { useOrbMessage } from "../../hooks/use-orb-message";
import { AuthDialog } from "../../app/AuthDialog";
import { ConnectDialog } from "../../app/ConnectDialog";
import { RuntimeModeDialog } from "../../app/RuntimeModeDialog";
import type { ChatContext, ChatContextUpdate } from "../../types/electron";

import { ChatColumn } from "./ChatColumn";
import { useOnboardingOverlay } from "./OnboardingOverlay";
import type { OnboardingDemo } from "../../components/onboarding/OnboardingCanvas";
import { useDiscoveryFlow } from "./DiscoveryFlow";
import { useStreamingChat } from "./use-streaming-chat";
import { useScrollManagement } from "./use-full-shell";
import { useBridgeAutoReconnect } from "../../hooks/use-bridge-reconnect";
import type { CommandSuggestion } from "../../hooks/use-command-suggestions";

const SettingsDialog = lazy(() => import("./SettingsView"));

type PersonalPage = {
  pageId: string;
  panelName: string;
  title: string;
  status: "queued" | "running" | "ready" | "failed";
  order: number;
};

type LocalWorkspacePanel = {
  name: string;
  title: string;
};

const LOCAL_PANEL_PAGE_PREFIX = "local_panel:";
const LOCAL_PANELS_POLL_INTERVAL_MS = 3_000;

const arePanelListsEqual = (
  left: LocalWorkspacePanel[],
  right: LocalWorkspacePanel[],
) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index]?.name !== right[index]?.name ||
      left[index]?.title !== right[index]?.title
    ) {
      return false;
    }
  }
  return true;
};

export const FullShell = () => {
  const { state, setView } = useUiState();
  const activeConversationId = state.conversationId;
  const { state: workspaceState, openCanvas, closeCanvas } = useWorkspace();
  const canvas = workspaceState.canvas;
  const { gradientMode, gradientColor } = useTheme();
  const isDev = import.meta.env.DEV;
  const restoredCanvasConversationRef = useRef<string | null>(null);
  const isNearBottomRef = useRef(true);

  const [message, setMessage] = useState("");
  const [chatContext, setChatContext] = useState<ChatContext | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [runtimeModeDialogOpen, setRuntimeModeDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [localWorkspacePanels, setLocalWorkspacePanels] = useState<
    LocalWorkspacePanel[]
  >([]);

  useBridgeAutoReconnect();

  const onboarding = useOnboardingOverlay();
  const accountMode = useQuery(
    api.data.preferences.getAccountMode,
    onboarding.isAuthenticated ? {} : "skip",
  ) as "private_local" | "connected" | undefined;
  const syncMode = useQuery(
    api.data.preferences.getSyncMode,
    onboarding.isAuthenticated && accountMode === "connected" ? {} : "skip",
  ) as "on" | "off" | undefined;
  const cloudFeaturesEnabled =
    onboarding.isAuthenticated && accountMode === "connected";
  const cloudStorageEnabled = cloudFeaturesEnabled && (syncMode ?? "on") !== "off";
  const conversationEventsSource = cloudStorageEnabled ? "cloud" : "local";

  const pagesResult = useQuery(
    api.personalized_dashboard.listPages,
    onboarding.isAuthenticated ? {} : "skip",
  ) as
    | {
        pages: Array<{
          pageId: string;
          panelName: string;
          title: string;
          status: "queued" | "running" | "ready" | "failed";
          order: number;
        }>;
        hasRunning: boolean;
      }
    | undefined;
  const cloudPages = pagesResult?.pages ?? [];

  useEffect(() => {
    const electronApi = getElectronApi();
    if (!electronApi?.listWorkspacePanels) {
      setLocalWorkspacePanels([]);
      return;
    }

    let cancelled = false;
    const loadPanels = async () => {
      try {
        const result = await electronApi.listWorkspacePanels();
        if (cancelled) return;

        const normalized = (Array.isArray(result) ? result : [])
          .filter(
            (panel): panel is LocalWorkspacePanel =>
              Boolean(
                panel &&
                  typeof panel.name === "string" &&
                  typeof panel.title === "string",
              ),
          )
          .map((panel) => ({
            name: panel.name.trim(),
            title: panel.title.trim() || panel.name.trim(),
          }))
          .filter((panel) => panel.name.length > 0);

        setLocalWorkspacePanels((previous) =>
          arePanelListsEqual(previous, normalized) ? previous : normalized,
        );
      } catch (error) {
        if (!cancelled) {
          console.warn("[FullShell] Failed to load local workspace pages", error);
        }
      }
    };

    void loadPanels();
    const intervalId = window.setInterval(() => {
      void loadPanels();
    }, LOCAL_PANELS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const personalPages = useMemo<PersonalPage[]>(() => {
    const pagesByPanelName = new Map<string, PersonalPage>();

    for (const page of cloudPages) {
      pagesByPanelName.set(page.panelName, page);
    }

    for (const panel of localWorkspacePanels) {
      const existing = pagesByPanelName.get(panel.name);
      if (existing) {
        // Local panel file exists, so the page is openable even if cloud status lags.
        pagesByPanelName.set(panel.name, {
          ...existing,
          status: "ready",
          title: existing.title || panel.title,
        });
        continue;
      }

      pagesByPanelName.set(panel.name, {
        pageId: `${LOCAL_PANEL_PAGE_PREFIX}${panel.name}`,
        panelName: panel.name,
        title: panel.title,
        status: "ready",
        order: Number.MAX_SAFE_INTEGER,
      });
    }

    return Array.from(pagesByPanelName.values()).sort(
      (left, right) => left.order - right.order || left.title.localeCompare(right.title),
    );
  }, [cloudPages, localWorkspacePanels]);

  const handlePageSelect = useCallback(
    (pageId: string) => {
      const page = personalPages.find((entry) => entry.pageId === pageId);
      if (page) {
        openCanvas({ name: page.panelName, title: page.title });
        setView("app");
      }
    },
    [personalPages, openCanvas, setView],
  );

  const handleTabSelect = useCallback(
    (view: "home" | "store" | "app" | "chat", page?: PersonalPage) => {
      if (view === "app" && page) {
        openCanvas({ name: page.panelName, title: page.title });
        setView("app");
      } else {
        setView(view);
      }
    },
    [openCanvas, setView],
  );

  const [activeDemo, setActiveDemo] = useState<OnboardingDemo>(null);
  const [demoClosing, setDemoClosing] = useState(false);
  const demoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDemoChange = useCallback((demo: OnboardingDemo) => {
    if (demo) {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current);
        demoCloseTimerRef.current = null;
      }
      setDemoClosing(false);
      setActiveDemo(demo);
    } else {
      setActiveDemo(null);
      setDemoClosing(true);
      demoCloseTimerRef.current = setTimeout(() => {
        setDemoClosing(false);
        demoCloseTimerRef.current = null;
      }, 400);
    }
  }, []);

  const { handleDiscoveryConfirm } = useDiscoveryFlow({
    isAuthenticated: onboarding.isAuthenticated,
    conversationId: activeConversationId,
    storageMode: conversationEventsSource,
  });

  const events = useConversationEvents(activeConversationId ?? undefined, {
    source: conversationEventsSource,
  });

  const {
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    queueNext,
    setQueueNext,
    selfModMap,
    sendMessage,
    syncWithEvents,
    processFollowUpQueue,
  } = useStreamingChat({
    conversationId: activeConversationId,
    storageMode: conversationEventsSource,
  });

  const {
    scrollContainerRef,
    isNearBottom,
    showScrollButton,
    scrollToBottom,
    handleScroll,
  } = useScrollManagement();

  useEffect(() => {
    isNearBottomRef.current = isNearBottom;
  }, [isNearBottom]);

  const isOrbVisible = state.view !== "chat" && onboarding.onboardingDone && !onboarding.isAuthLoading;
  const orbMessage = useOrbMessage(events, isOrbVisible);

  useEffect(() => {
    const ready = onboarding.onboardingDone && !onboarding.isAuthLoading;
    window.electronAPI?.setAppReady?.(ready);
  }, [onboarding.onboardingDone, onboarding.isAuthLoading]);

  useEffect(() => {
    const electronApi = getElectronApi();
    if (!electronApi) return;

    electronApi
      .getChatContext?.()
      .then((context) => {
        if (!context) return;
        setChatContext(context);
        setSelectedText(context.selectedText ?? null);
      })
      .catch((error) => {
        console.warn("Failed to load chat context", error);
      });

    if (!electronApi.onChatContext) return;

    const unsubscribe = electronApi.onChatContext((payload) => {
      let context: ChatContext | null = null;
      if (payload && typeof payload === "object" && "context" in payload) {
        context = (payload as ChatContextUpdate).context ?? null;
      } else {
        context = (payload as ChatContext | null) ?? null;
      }
      setChatContext(context);
      setSelectedText(context?.selectedText ?? null);
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  useCanvasCommands(events);

  // Restore saved canvas state when switching conversations
  const savedCanvasCloudState = useQuery(
    api.data.canvas_states.getForConversation,
    activeConversationId && cloudFeaturesEnabled
      ? { conversationId: activeConversationId }
      : "skip",
  ) as
    | {
        name: string;
        title?: string;
        url?: string;
        width?: number;
      }
    | null
    | undefined;
  const savedCanvasState = savedCanvasCloudState;

  useEffect(() => {
    if (!state.conversationId) {
      restoredCanvasConversationRef.current = null;
      return;
    }

    if (savedCanvasState === undefined) {
      return;
    }

    if (restoredCanvasConversationRef.current === state.conversationId) {
      return;
    }

    if (!savedCanvasState) {
      closeCanvas();
      restoredCanvasConversationRef.current = state.conversationId;
      return;
    }

    openCanvas({
      name: savedCanvasState.name,
      title: savedCanvasState.title,
      url: savedCanvasState.url,
    });

    restoredCanvasConversationRef.current = state.conversationId;
  }, [state.conversationId, savedCanvasState, openCanvas, closeCanvas]);

  useEffect(() => {
    syncWithEvents(events);
  }, [events, syncWithEvents]);

  useEffect(() => {
    processFollowUpQueue(events);
  }, [events, processFollowUpQueue]);

  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom("smooth");
    }
  }, [events.length, scrollToBottom]);

  useEffect(() => {
    if (isStreaming && isNearBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [
    streamingText,
    reasoningText,
    isStreaming,
    scrollToBottom,
  ]);

  const handleSend = useCallback(() => {
    void sendMessage({
      text: message,
      selectedText,
      chatContext,
      onClear: () => {
        setMessage("");
        setSelectedText(null);
        setChatContext(null);
      },
    });
  }, [message, selectedText, chatContext, sendMessage]);

  const handleCommandSelect = useCallback(
    (suggestion: CommandSuggestion) => {
      void sendMessage({
        text: `Run the command "${suggestion.name}" (${suggestion.description}). Create a task for the general agent with command_id "${suggestion.commandId}", using the current or most recently used thread.`,
        selectedText: null,
        chatContext: null,
        onClear: () => {},
      });
    },
    [sendMessage],
  );

  // Listen for custom events from the home view (suggestion clicks)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string }>).detail;
      if (detail?.text) {
        void sendMessage({
          text: detail.text,
          selectedText: null,
          chatContext: null,
          onClear: () => {},
        });
      }
    };
    window.addEventListener("stella:send-message", handler);
    return () => window.removeEventListener("stella:send-message", handler);
  }, [sendMessage]);

  const hasScreenshotContext = Boolean(chatContext?.regionScreenshots?.length);
  const hasWindowContext = Boolean(chatContext?.window);
  const hasSelectedTextContext = Boolean(selectedText);
  const hasComposerContext = Boolean(
    hasScreenshotContext ||
      hasWindowContext ||
      hasSelectedTextContext ||
      chatContext?.capturePending,
  );
  const canSubmit = Boolean(
    activeConversationId && (message.trim() || hasComposerContext),
  );

  const appReady = onboarding.onboardingDone && !onboarding.isAuthLoading;

  const chatColumnProps = {
    events,
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    message,
    setMessage,
    chatContext,
    setChatContext,
    selectedText,
    setSelectedText,
    queueNext,
    setQueueNext,
    scrollContainerRef,
    handleScroll,
    showScrollButton,
    scrollToBottom,
    conversationId: activeConversationId,
    onboardingDone: onboarding.onboardingDone,
    onboardingExiting: onboarding.onboardingExiting,
    isAuthenticated: onboarding.isAuthenticated,
    isAuthLoading: onboarding.isAuthLoading,
    canSubmit,
    onSend: handleSend,
    hasExpanded: onboarding.hasExpanded,
    splitMode: onboarding.splitMode,
    hasDiscoverySelections: onboarding.hasDiscoverySelections,
    onboardingKey: onboarding.onboardingKey,
    stellaAnimationRef: onboarding.stellaAnimationRef,
    triggerFlash: onboarding.triggerFlash,
    startBirthAnimation: onboarding.startBirthAnimation,
    completeOnboarding: onboarding.completeOnboarding,
    handleEnterSplit: onboarding.handleEnterSplit,
    onDiscoveryConfirm: handleDiscoveryConfirm,
    onSelectionChange: onboarding.setHasDiscoverySelections,
    onDemoChange: handleDemoChange,
    onCommandSelect: handleCommandSelect,
  };

  const handleOrbSend = useCallback(
    (text: string) => {
      void sendMessage({ text, selectedText: null, chatContext: null, onClear: () => {} });
    },
    [sendMessage],
  );

  return (
    <div className="window-shell full">
      <TitleBar />
      <ShiftingGradient mode={gradientMode} colorMode={gradientColor} />

      <div className="full-body">
        {appReady ? (
          <>
            <Sidebar
              onSignIn={() => setAuthDialogOpen(true)}
              onConnect={() => setConnectDialogOpen(true)}
              onSettings={() => setSettingsDialogOpen(true)}
              onStore={() => setView(state.view === 'store' ? 'home' : 'store')}
              onHome={() => setView('home')}
              storeActive={state.view === 'store'}
            />

            <div className="content-area">
              <HeaderTabBar
                activeView={state.view}
                activeCanvasName={canvas?.name}
                pages={personalPages}
                onTabSelect={handleTabSelect}
              />

              {state.view === "chat" ? (
                <ChatColumn {...chatColumnProps} />
              ) : (
                <WorkspaceArea
                  view={state.view}
                  activeDemo={activeDemo}
                  demoClosing={demoClosing}
                  onStoreBack={() => setView('home')}
                  onComposePrompt={(text) => {
                    setView("home");
                    setMessage(text);
                  }}
                  conversationId={activeConversationId ?? undefined}
                  eventsSource={conversationEventsSource}
                />
              )}

              <FloatingOrb
                visible={isOrbVisible}
                bubbleText={orbMessage.text}
                bubbleOpacity={orbMessage.opacity}
                isStreaming={isStreaming}
                onSend={handleOrbSend}
              />
            </div>
          </>
        ) : (
          <ChatColumn {...chatColumnProps} />
        )}
      </div>

      <AuthDialog open={authDialogOpen} onOpenChange={setAuthDialogOpen} />
      <ConnectDialog
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
      />
      <RuntimeModeDialog
        open={runtimeModeDialogOpen}
        onOpenChange={setRuntimeModeDialogOpen}
      />
      <Suspense fallback={null}>
        <SettingsDialog
          open={settingsDialogOpen}
          onOpenChange={setSettingsDialogOpen}
          onOpenRuntimeMode={() => {
            setSettingsDialogOpen(false);
            setRuntimeModeDialogOpen(true);
          }}
          onSignOut={() => {
            setSettingsDialogOpen(false);
            void secureSignOut();
          }}
        />
      </Suspense>

      {isDev && (
        <button
          className="onboarding-reset"
          onClick={onboarding.handleResetOnboarding}
        >
          Reset Onboarding
        </button>
      )}
    </div>
  );
};
