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
import { useDiscoveryFlow } from "./DiscoveryFlow";
import { useStreamingChat } from "./use-streaming-chat";
import { useScrollManagement } from "./use-full-shell";
import { useBridgeAutoReconnect } from "../../hooks/use-bridge-reconnect";

const StoreView = lazy(() => import("./StoreView"));

export const FullShell = () => {
  const { state, setView } = useUiState();
  const { state: canvasState, openCanvas, closeCanvas, setWidth } = useCanvas();
  const { gradientMode, gradientColor } = useTheme();
  const isDev = import.meta.env.DEV;
  const restoredCanvasConversationRef = useRef<string | null>(null);

  const [message, setMessage] = useState("");
  const [chatContext, setChatContext] = useState<ChatContext | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [runtimeModeDialogOpen, setRuntimeModeDialogOpen] = useState(false);

  // Auto-reconnect local bridges on launch
  useBridgeAutoReconnect();

  // Onboarding
  const onboarding = useOnboardingOverlay();

  // Discovery
  const { handleDiscoveryConfirm } = useDiscoveryFlow({
    isAuthenticated: onboarding.isAuthenticated,
    onboardingDone: onboarding.onboardingDone,
    conversationId: state.conversationId,
  });

  // Streaming chat
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

  // Scroll management
  const {
    scrollContainerRef,
    isNearBottom,
    showScrollButton,
    scrollToBottom,
    handleScroll,
  } = useScrollManagement();

  // Broadcast gate state to main process
  useEffect(() => {
    const ready = onboarding.isAuthenticated && onboarding.onboardingDone;
    window.electronAPI?.setAppReady?.(ready);
  }, [onboarding.isAuthenticated, onboarding.onboardingDone]);

  // Chat context from Electron
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

  // Events
  const events = useConversationEvents(state.conversationId ?? undefined);
  useCanvasCommands(events);

  const savedCanvasState = useQuery(
    api.data.canvas_states.getForConversation,
    state.conversationId
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

  // Sync streaming with events
  useEffect(() => {
    syncWithEvents(events);
  }, [events, syncWithEvents]);

  // Process follow-up queue
  useEffect(() => {
    processFollowUpQueue(events);
  }, [events, processFollowUpQueue]);

  // Auto-scroll when persisted conversation content arrives
  useEffect(() => {
    if (isNearBottom) {
      scrollToBottom("smooth");
    }
  }, [events.length, isNearBottom, scrollToBottom]);

  // Keep viewport pinned during streaming
  useEffect(() => {
    if (isStreaming && isNearBottom) {
      scrollToBottom("auto");
    }
  }, [
    streamingText,
    reasoningText,
    isStreaming,
    isNearBottom,
    scrollToBottom,
  ]);

  const handleSend = useCallback(() => {
    const hasScreenshotCtx = Boolean(chatContext?.regionScreenshots?.length);
    void sendMessage({
      text: message,
      selectedText,
      chatContext,
      onClear: () => {
        setMessage("");
        if (!hasScreenshotCtx && !selectedText?.trim() && !chatContext?.window) {
          // Composer will collapse naturally
        }
        setSelectedText(null);
        setChatContext(null);
      },
    });
    setMessage("");
  }, [message, selectedText, chatContext, sendMessage]);

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
  const shellClassName = `window-shell full${canvasOpen ? " has-canvas" : ""}`;
  const canvasWidthVar = canvasOpen
    ? ({
        "--canvas-panel-width": `${canvasState.width}px`,
      } as React.CSSProperties)
    : undefined;

  return (
    <div className={shellClassName} style={canvasWidthVar}>
      <TitleBar />
      <ShiftingGradient mode={gradientMode} colorMode={gradientColor} />

      <div className="full-body">
        <Sidebar
          hideThemePicker={!onboarding.onboardingDone}
          themePickerOpen={onboarding.themePickerOpen}
          onThemePickerOpenChange={onboarding.setThemePickerOpen}
          onThemeSelect={onboarding.handleThemeSelect}
          onSignIn={() => setAuthDialogOpen(true)}
          onConnect={() => setConnectDialogOpen(true)}
          onSettings={() => setRuntimeModeDialogOpen(true)}
          onStore={() => setView(state.view === 'store' ? 'chat' : 'store')}
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
              isAuthenticated={onboarding.isAuthenticated}
              isAuthLoading={onboarding.isAuthLoading}
              canSubmit={canSubmit}
              onSend={handleSend}
              hasExpanded={onboarding.hasExpanded}
              onboardingKey={onboarding.onboardingKey}
              blackHoleRef={onboarding.blackHoleRef}
              triggerFlash={onboarding.triggerFlash}
              startBirthAnimation={onboarding.startBirthAnimation}
              completeOnboarding={onboarding.completeOnboarding}
              handleOpenThemePicker={onboarding.handleOpenThemePicker}
              handleConfirmTheme={onboarding.handleConfirmTheme}
              themeConfirmed={onboarding.themeConfirmed}
              hasSelectedTheme={onboarding.hasSelectedTheme}
              onDiscoveryConfirm={handleDiscoveryConfirm}
              onSignIn={() => setAuthDialogOpen(true)}
            />
            {canvasOpen && <CanvasPanel />}
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
