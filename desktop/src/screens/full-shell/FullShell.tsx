/**
 * FullShell: Layout shell that imports sub-components, holds top-level state,
 * renders .full-body grid: Sidebar | WorkspaceArea | ChatPanel.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { useUiState } from "../../app/state/ui-state";
import { useWorkspace } from "../../app/state/workspace-state";
import { useTheme } from "../../theme/theme-context";
import { useConversationEvents } from "../../hooks/use-conversation-events";
import { useCanvasCommands } from "../../hooks/use-canvas-commands";
import { getElectronApi } from "../../services/electron";
import { secureSignOut } from "../../services/auth";
import { getOrCreateDeviceId } from "../../services/device";
import { api } from "@/convex/api";
import { ShiftingGradient } from "../../components/background/ShiftingGradient";
import { TitleBar } from "../../components/TitleBar";
import { Sidebar } from "../../components/Sidebar";
import { WorkspaceArea } from "../../components/workspace/WorkspaceArea";
import { ChatPanel } from "../../components/chat/ChatPanel";
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
import type { PersonalizedDashboardPage, PersonalizedDashboardPageList } from "../../types/personalized-dashboard";

const SettingsDialog = lazy(() => import("./SettingsView"));

export const FullShell = () => {
  const { state, setView } = useUiState();
  const activeConversationId = state.conversationId;
  const { state: workspaceState, openCanvas, closeCanvas } = useWorkspace();
  const { gradientMode, gradientColor } = useTheme();
  const isDev = import.meta.env.DEV;
  const restoredCanvasConversationRef = useRef<string | null>(null);
  const isNearBottomRef = useRef(true);
  const dashboardBootstrapAttemptedRef = useRef<Set<string>>(new Set());
  const panelLoadRecoveryRef = useRef<Set<string>>(new Set());

  const [message, setMessage] = useState("");
  const [chatContext, setChatContext] = useState<ChatContext | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [runtimeModeDialogOpen, setRuntimeModeDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);

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
    isAuthenticated: cloudFeaturesEnabled,
    conversationId: cloudFeaturesEnabled ? activeConversationId : null,
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

  useEffect(() => {
    const ready = onboarding.isAuthenticated && onboarding.onboardingDone;
    window.electronAPI?.setAppReady?.(ready);
  }, [onboarding.isAuthenticated, onboarding.onboardingDone]);

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
  const retryPersonalPage = useAction(api.personalized_dashboard.retryPage);
  const startDashboardGeneration = useAction(
    api.personalized_dashboard.startGeneration,
  );

  const personalizedPageState = useQuery(
    api.personalized_dashboard.listPages,
    cloudFeaturesEnabled ? {} : "skip",
  ) as PersonalizedDashboardPageList | undefined;
  const personalPages = personalizedPageState?.pages ?? [];

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

  const handlePersonalPageSelect = useCallback(
    (page: PersonalizedDashboardPage) => {
      setView("chat");
      openCanvas({
        name: page.panelName,
        title: page.title,
      });
    },
    [openCanvas, setView],
  );

  const handleRetryPersonalPage = useCallback(
    (pageId: string) => {
      if (!activeConversationId || !cloudFeaturesEnabled) return;
      void (async () => {
        const targetDeviceId = await getOrCreateDeviceId();
        await retryPersonalPage({
          conversationId: activeConversationId,
          pageId,
          targetDeviceId,
        });
      })().catch(() => {
        // Silent fail - workspace surface already shows failure state
      });
    },
    [activeConversationId, cloudFeaturesEnabled, retryPersonalPage],
  );

  // Listen for custom events from the dashboard panel (suggestion clicks)
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

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ panelName?: string; error?: string }>).detail;
      if (!cloudFeaturesEnabled) return;
      const panelName = detail?.panelName?.trim();
      if (!panelName || !activeConversationId) return;

      const page = personalPages.find((entry) => entry.panelName === panelName);
      if (!page) return;
      if (panelLoadRecoveryRef.current.has(page.pageId)) return;
      panelLoadRecoveryRef.current.add(page.pageId);

      void (async () => {
        const targetDeviceId = await getOrCreateDeviceId();
        await retryPersonalPage({
          conversationId: activeConversationId,
          pageId: page.pageId,
          targetDeviceId,
        });
      })().catch(() => {
        panelLoadRecoveryRef.current.delete(page.pageId);
      });
    };

    window.addEventListener("stella:panel-load-failed", handler);
    return () => window.removeEventListener("stella:panel-load-failed", handler);
  }, [activeConversationId, cloudFeaturesEnabled, personalPages, retryPersonalPage]);

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

  const appReady = onboarding.isAuthenticated && onboarding.onboardingDone;

  useEffect(() => {
    if (!cloudFeaturesEnabled) return;
    if (!appReady || !activeConversationId) return;
    if (personalizedPageState === undefined) return;
    if (dashboardBootstrapAttemptedRef.current.has(activeConversationId)) return;

    if (personalizedPageState.pages.length > 0 || personalizedPageState.hasRunning) {
      dashboardBootstrapAttemptedRef.current.add(activeConversationId);
      return;
    }

    dashboardBootstrapAttemptedRef.current.add(activeConversationId);
    void (async () => {
      const targetDeviceId = await getOrCreateDeviceId();
      await startDashboardGeneration({
        conversationId: activeConversationId,
        targetDeviceId,
      });
    })().catch(() => {
      dashboardBootstrapAttemptedRef.current.delete(activeConversationId);
    });
  }, [
    activeConversationId,
    appReady,
    cloudFeaturesEnabled,
    personalizedPageState,
    startDashboardGeneration,
  ]);

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
              onStore={() => setView(state.view === 'store' ? 'chat' : 'store')}
              onHome={() => setView('chat')}
              storeActive={state.view === 'store'}
              personalPages={personalPages}
              personalPagesLoading={Boolean(personalizedPageState?.hasRunning)}
              activePersonalPanelName={workspaceState.canvas?.name ?? null}
              onPersonalPageSelect={handlePersonalPageSelect}
            />

            <WorkspaceArea
              view={state.view}
              isAuthenticated={onboarding.isAuthenticated}
              onboardingDone={onboarding.onboardingDone}
              activeDemo={activeDemo}
              demoClosing={demoClosing}
              onStoreBack={() => setView('chat')}
              onComposePrompt={(text) => {
                setView("chat");
                setMessage(text);
              }}
              personalPages={personalPages}
              onRetryPersonalPage={handleRetryPersonalPage}
            />

            <ChatPanel>
              <ChatColumn
                events={events}
                streamingText={streamingText}
                reasoningText={reasoningText}
                isStreaming={isStreaming}
                pendingUserMessageId={pendingUserMessageId}
                message={message}
                setMessage={setMessage}
                chatContext={chatContext}
                setChatContext={setChatContext}
                selectedText={selectedText}
                setSelectedText={setSelectedText}
                queueNext={queueNext}
                setQueueNext={setQueueNext}
                scrollContainerRef={scrollContainerRef}
                handleScroll={handleScroll}
                showScrollButton={showScrollButton}
                scrollToBottom={scrollToBottom}
                conversationId={activeConversationId}
                onboardingDone={onboarding.onboardingDone}
                onboardingExiting={onboarding.onboardingExiting}
                isAuthenticated={onboarding.isAuthenticated}
                isAuthLoading={onboarding.isAuthLoading}
                canSubmit={canSubmit}
                onSend={handleSend}
                hasExpanded={onboarding.hasExpanded}
                splitMode={onboarding.splitMode}
                hasDiscoverySelections={onboarding.hasDiscoverySelections}
                onboardingKey={onboarding.onboardingKey}
                stellaAnimationRef={onboarding.stellaAnimationRef}
                triggerFlash={onboarding.triggerFlash}
                startBirthAnimation={onboarding.startBirthAnimation}
                completeOnboarding={onboarding.completeOnboarding}
                handleEnterSplit={onboarding.handleEnterSplit}
                onDiscoveryConfirm={handleDiscoveryConfirm}
                onSelectionChange={onboarding.setHasDiscoverySelections}
                onDemoChange={handleDemoChange}
                onCommandSelect={handleCommandSelect}
              />
            </ChatPanel>
          </>
        ) : (
          <ChatColumn
            events={events}
            streamingText={streamingText}
            reasoningText={reasoningText}
            isStreaming={isStreaming}
            pendingUserMessageId={pendingUserMessageId}
            message={message}
            setMessage={setMessage}
            chatContext={chatContext}
            setChatContext={setChatContext}
            selectedText={selectedText}
            setSelectedText={setSelectedText}
            queueNext={queueNext}
            setQueueNext={setQueueNext}
            scrollContainerRef={scrollContainerRef}
            handleScroll={handleScroll}
            showScrollButton={showScrollButton}
            scrollToBottom={scrollToBottom}
            conversationId={activeConversationId}
            onboardingDone={onboarding.onboardingDone}
            onboardingExiting={onboarding.onboardingExiting}
            isAuthenticated={onboarding.isAuthenticated}
            isAuthLoading={onboarding.isAuthLoading}
            canSubmit={canSubmit}
            onSend={handleSend}
            hasExpanded={onboarding.hasExpanded}
            splitMode={onboarding.splitMode}
            hasDiscoverySelections={onboarding.hasDiscoverySelections}
            onboardingKey={onboarding.onboardingKey}
            stellaAnimationRef={onboarding.stellaAnimationRef}
            triggerFlash={onboarding.triggerFlash}
            startBirthAnimation={onboarding.startBirthAnimation}
            completeOnboarding={onboarding.completeOnboarding}
            handleEnterSplit={onboarding.handleEnterSplit}
            onDiscoveryConfirm={handleDiscoveryConfirm}
            onSelectionChange={onboarding.setHasDiscoverySelections}
            onDemoChange={handleDemoChange}
            onCommandSelect={handleCommandSelect}
          />
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
