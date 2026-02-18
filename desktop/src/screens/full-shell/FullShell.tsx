/**
 * FullShell: Layout shell that imports sub-components, holds top-level state,
 * renders .full-body grid.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { useUiState } from "../../app/state/ui-state";
import { useCanvas } from "../../app/state/canvas-state";
import { useTheme } from "../../theme/theme-context";
import { useConversationEvents } from "../../hooks/use-conversation-events";
import { useCanvasCommands } from "../../hooks/use-canvas-commands";
import { getElectronApi } from "../../services/electron";
import { secureSignOut } from "../../services/auth";
import { api } from "@/convex/api";
import { ShiftingGradient } from "../../components/background/ShiftingGradient";
import { TitleBar } from "../../components/TitleBar";
import { Sidebar } from "../../components/Sidebar";
import { CanvasPanel } from "../../components/canvas/CanvasPanel";
import { AuthDialog } from "../../app/AuthDialog";
import { ConnectDialog } from "../../app/ConnectDialog";
import { RuntimeModeDialog } from "../../app/RuntimeModeDialog";
import type { ChatContext, ChatContextUpdate } from "../../types/electron";

import { ChatColumn } from "./ChatColumn";
import { useOnboardingOverlay } from "./OnboardingOverlay";
import { OnboardingCanvas, type OnboardingDemo } from "../../components/onboarding/OnboardingCanvas";
import { useDiscoveryFlow } from "./DiscoveryFlow";
import { useStreamingChat } from "./use-streaming-chat";
import { useScrollManagement } from "./use-full-shell";
import { useBridgeAutoReconnect } from "../../hooks/use-bridge-reconnect";
import { useVoiceInput } from "../../hooks/use-voice-input";
import type { CommandSuggestion } from "../../hooks/use-command-suggestions";
import { useIsLocalMode } from "@/providers/DataProvider";
import { useLocalQuery } from "@/hooks/use-local-query";

const StoreView = lazy(() => import("./StoreView"));
const SettingsDialog = lazy(() => import("./SettingsView"));

export const FullShell = () => {
  const { state, setView } = useUiState();
  const isLocalMode = useIsLocalMode();
  const { state: canvasState, openCanvas, closeCanvas, setWidth } = useCanvas();
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
  const [partialTranscript, setPartialTranscript] = useState("");

  useBridgeAutoReconnect();

  const onboarding = useOnboardingOverlay();

  // STT voice input
  const sttCloudResult = useQuery(
    api.data.stt.checkSttAvailable,
    !isLocalMode && onboarding.isAuthenticated ? {} : "skip",
  ) as { available: boolean } | undefined;
  const sttLocalResult = useLocalQuery<{ available: boolean }>(
    isLocalMode ? "/api/stt/check-available" : null,
  );
  const sttAvailable = isLocalMode
    ? (sttLocalResult.data?.available ?? false)
    : (sttCloudResult?.available ?? false);

  const voice = useVoiceInput({
    onPartialTranscript: setPartialTranscript,
    onFinalTranscript: useCallback((text: string) => {
      setMessage((prev) => (prev ? prev + " " + text : text));
      setPartialTranscript("");
    }, []),
    onError: useCallback((err: string) => {
      console.warn("STT error:", err);
      setPartialTranscript("");
    }, []),
  });

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
      // Both state changes in same handler → batched into one render
      // so the component never unmounts between frames
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
    conversationId: state.conversationId,
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
    conversationId: state.conversationId,
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

  const events = useConversationEvents(state.conversationId ?? undefined);
  useCanvasCommands(events);

  const savedCanvasCloudState = useQuery(
    api.data.canvas_states.getForConversation,
    !isLocalMode && state.conversationId && onboarding.isAuthenticated
      ? { conversationId: state.conversationId }
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
  const savedCanvasLocalState = useLocalQuery<
    | {
        name?: string;
        title?: string | null;
        url?: string | null;
        width?: number | null;
      }
    | null
  >(
    isLocalMode && state.conversationId
      ? `/api/canvas-states/${encodeURIComponent(state.conversationId)}`
      : null,
  );
  const savedCanvasState = isLocalMode
    ? savedCanvasLocalState.data === undefined
      ? undefined
      : savedCanvasLocalState.data
        ? {
            name: savedCanvasLocalState.data.name ?? "",
            title: savedCanvasLocalState.data.title ?? undefined,
            url: savedCanvasLocalState.data.url ?? undefined,
            width:
              typeof savedCanvasLocalState.data.width === "number"
                ? savedCanvasLocalState.data.width
                : undefined,
          }
        : null
    : savedCanvasCloudState;

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

    if (typeof savedCanvasState.width === "number") {
      setWidth(savedCanvasState.width);
    }

    restoredCanvasConversationRef.current = state.conversationId;
  }, [state.conversationId, savedCanvasState, openCanvas, closeCanvas, setWidth]);

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
    setMessage("");
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

  // Auto-open the dashboard panel when ready and no other canvas is active.
  // Re-opens dashboard after an agent canvas closes, but NOT if the user
  // manually closed the dashboard itself.
  const canvasOpen = canvasState.isOpen && canvasState.canvas !== null;
  const isDashboardCanvas = canvasState.canvas?.name === "dashboard";
  const [dashboardDismissed, setDashboardDismissed] = useState(false);
  const prevCanvasRef = useRef<{ isOpen: boolean; name?: string }>({ isOpen: false });

  // Track closing animation so CanvasPanel stays mounted during exit
  const CANVAS_ANIM_MS = 350; // matches CSS canvas-slide-out duration
  const [canvasClosing, setCanvasClosing] = useState(false);
  const canvasWasOpenRef = useRef(false);

  useEffect(() => {
    const wasOpen = canvasWasOpenRef.current;
    canvasWasOpenRef.current = canvasOpen;

    if (wasOpen && !canvasOpen) {
      setCanvasClosing(true);
      const timer = setTimeout(() => setCanvasClosing(false), CANVAS_ANIM_MS);
      return () => clearTimeout(timer);
    }
    if (canvasOpen) {
      setCanvasClosing(false);
    }
  }, [canvasOpen]);

  // Keep panel mounted on the exact close-transition frame as well.
  // Without this guard there is a one-render gap before canvasClosing turns true,
  // which skips the exit animation.
  const canvasJustClosed = canvasWasOpenRef.current && !canvasOpen;
  const showCanvasPanel = canvasOpen || canvasClosing || canvasJustClosed;

  useEffect(() => {
    const wasOpen = prevCanvasRef.current.isOpen;
    const wasName = prevCanvasRef.current.name;
    prevCanvasRef.current = { isOpen: canvasOpen, name: canvasState.canvas?.name };

    // Detect user closing the dashboard — mark as dismissed
    if (wasOpen && !canvasOpen && wasName === "dashboard") {
      setDashboardDismissed(true);
      return;
    }

    // When a non-dashboard canvas opens, clear the dismissed flag
    // so dashboard returns when that canvas closes
    if (canvasOpen && !isDashboardCanvas) {
      setDashboardDismissed(false);
      return;
    }

    const ready = onboarding.isAuthenticated && onboarding.onboardingDone;
    if (!ready || activeDemo || demoClosing) return;
    if (canvasOpen || canvasClosing) return;
    if (dashboardDismissed) return;
    openCanvas({ name: "dashboard" });
  }, [onboarding.isAuthenticated, onboarding.onboardingDone, canvasOpen, canvasClosing, isDashboardCanvas, canvasState.canvas?.name, activeDemo, demoClosing, dashboardDismissed, openCanvas]);

  const handleOpenDashboard = useCallback(() => {
    setDashboardDismissed(false);
    openCanvas({ name: "dashboard" });
  }, [openCanvas]);

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
    state.conversationId && (message.trim() || hasComposerContext),
  );
  const shellClassName = `window-shell full${showCanvasPanel || activeDemo || demoClosing ? " has-canvas" : ""}`;
  const canvasWidthVar = showCanvasPanel
    ? ({
        "--canvas-panel-width": `${canvasState.width}px`,
      } as React.CSSProperties)
    : (activeDemo || demoClosing)
    ? ({
        "--canvas-panel-width": "420px",
      } as React.CSSProperties)
    : undefined;

  return (
    <div className={shellClassName} style={canvasWidthVar}>
      <TitleBar />
      <ShiftingGradient mode={gradientMode} colorMode={gradientColor} />

      <div className="full-body">
        <Sidebar
          onSignIn={() => setAuthDialogOpen(true)}
          onConnect={() => setConnectDialogOpen(true)}
          onSettings={() => setSettingsDialogOpen(true)}
          onStore={() => setView(state.view === 'store' ? 'chat' : 'store')}
          onHome={() => setView('chat')}
          storeActive={state.view === 'store'}
        />
        {state.view === 'store' ? (
          <Suspense fallback={<div className="store-loading">Loading Store...</div>}>
            <StoreView
              onBack={() => setView('chat')}
              onComposePrompt={(text) => {
                setView("chat");
                setMessage(text);
              }}
            />
          </Suspense>
        ) : (
          <>
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
              conversationId={state.conversationId}
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
              sttAvailable={sttAvailable}
              voiceState={voice.state}
              onStartVoice={voice.startRecording}
              onStopVoice={voice.stopRecording}
              partialTranscript={partialTranscript}
            />
            {showCanvasPanel && <CanvasPanel />}
            {!showCanvasPanel && (activeDemo || demoClosing) && <OnboardingCanvas activeDemo={activeDemo} />}
            {!showCanvasPanel && !activeDemo && !demoClosing && dashboardDismissed && onboarding.isAuthenticated && onboarding.onboardingDone && (
              <button
                className="canvas-panel-toggle"
                onClick={handleOpenDashboard}
                aria-label="Open dashboard"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
          </>
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
