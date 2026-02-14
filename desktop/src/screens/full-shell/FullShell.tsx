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
import type { CommandSuggestion } from "../../hooks/use-command-suggestions";

const StoreView = lazy(() => import("./StoreView"));
const SettingsDialog = lazy(() => import("./SettingsView"));

export const FullShell = () => {
  const { state, setView } = useUiState();
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

  useBridgeAutoReconnect();

  const onboarding = useOnboardingOverlay();
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

  const savedCanvasState = useQuery(
    api.data.canvas_states.getForConversation,
    state.conversationId && onboarding.isAuthenticated
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

  const handleWelcomeSuggestionSelect = useCallback(
    (suggestion: { prompt: string }) => {
      void sendMessage({
        text: suggestion.prompt,
        selectedText: null,
        chatContext: null,
        onClear: () => {},
      });
    },
    [sendMessage],
  );

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

  const canvasOpen = canvasState.isOpen && canvasState.canvas !== null;
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
  const shellClassName = `window-shell full${canvasOpen || activeDemo || demoClosing ? " has-canvas" : ""}`;
  const canvasWidthVar = canvasOpen
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
              onboardingKey={onboarding.onboardingKey}
              stellaAnimationRef={onboarding.stellaAnimationRef}
              triggerFlash={onboarding.triggerFlash}
              startBirthAnimation={onboarding.startBirthAnimation}
              completeOnboarding={onboarding.completeOnboarding}
              handleEnterSplit={onboarding.handleEnterSplit}
              onDiscoveryConfirm={handleDiscoveryConfirm}
              onSignIn={() => setAuthDialogOpen(true)}
              onDemoChange={handleDemoChange}
              onCommandSelect={handleCommandSelect}
              onWelcomeSuggestionSelect={handleWelcomeSuggestionSelect}
            />
            {canvasOpen && <CanvasPanel />}
            {!canvasOpen && (activeDemo || demoClosing) && <OnboardingCanvas activeDemo={activeDemo} />}
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
            import("@/lib/auth-client").then(({ authClient }) => authClient.signOut());
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
