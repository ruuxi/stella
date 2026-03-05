/**
 * FullShell: Layout shell that imports sub-components, holds top-level state,
 * renders .full-body grid: Sidebar | WorkspaceArea | ChatPanel.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUiState } from "@/providers/ui-state";
import { useWorkspace } from "@/providers/workspace-state";
import { useTheme } from "@/theme/theme-context";
import { useConversationEvents } from "@/hooks/use-conversation-events";
import { useCanvasCommands } from "@/hooks/use-canvas-commands";
import { secureSignOut } from "@/services/auth";
import { ShiftingGradient } from "@/app/shell/background/ShiftingGradient";
import { TitleBar } from "@/app/shell/TitleBar";
import { Sidebar } from "@/app/sidebar/Sidebar";
import { WorkspaceArea } from "@/app/canvas/WorkspaceArea";
import { HeaderTabBar } from "@/app/shell/HeaderTabBar";
import { FloatingOrb, type FloatingOrbHandle } from "@/app/shell/FloatingOrb";
import { useOrbMessage } from "@/hooks/use-orb-message";

import { ChatColumn } from "../chat/ChatColumn";
import type { ChatColumnProps } from "../chat/ChatColumn";
import { useOnboardingOverlay } from "../onboarding/OnboardingOverlay";
import { useDiscoveryFlow } from "../onboarding/DiscoveryFlow";
import { useStreamingChat } from "@/hooks/use-streaming-chat";
import { useScrollManagement } from "./use-full-shell";
import { useBridgeAutoReconnect } from "@/hooks/use-bridge-reconnect";
import { useReturnDetection, formatDuration } from "@/hooks/use-return-detection";
import type { CommandSuggestion } from "@/hooks/use-command-suggestions";
import { MiniBridgeRelay } from "@/services/MiniBridgeRelay";

import {
  useLocalWorkspacePanels,
  useChatContextSync,
  useDemoAnimation,
  useDialogManager,
  type PersonalPage,
} from "./hooks";

const SettingsDialog = lazy(() => import("../settings/SettingsView"));
const AuthDialog = lazy(() => import("@/app/auth/AuthDialog").then(m => ({ default: m.AuthDialog })));
const ConnectDialog = lazy(() => import("@/app/integrations/ConnectDialog").then(m => ({ default: m.ConnectDialog })));
const SelfModTestDialog = lazy(() => import("@/testing/SelfModTestDialog"));

export const FullShell = () => {
  const { state, setView } = useUiState();
  const activeConversationId = state.conversationId;
  const { state: workspaceState, openCanvas } = useWorkspace();
  const canvas = workspaceState.canvas;
  const { gradientMode, gradientColor } = useTheme();
  const isDev = import.meta.env.DEV;
  const isNearBottomRef = useRef(true);

  const [message, setMessage] = useState("");

  useBridgeAutoReconnect();

  const onboarding = useOnboardingOverlay();
  const { personalPages } = useLocalWorkspacePanels();
  const { chatContext, setChatContext, selectedText, setSelectedText } = useChatContextSync();
  const { activeDemo, demoClosing, handleDemoChange } = useDemoAnimation();
  const { activeDialog, setActiveDialog } = useDialogManager();

  const handleTabSelect = useCallback(
    (view: "home" | "app" | "chat", page?: PersonalPage) => {
      if (view === "app" && page) {
        openCanvas({ name: page.panelName, title: page.title });
        setView("app");
      } else {
        setView(view);
      }
    },
    [openCanvas, setView],
  );

  const { handleDiscoveryConfirm } = useDiscoveryFlow({
    conversationId: activeConversationId,
  });

  const events = useConversationEvents(activeConversationId ?? undefined);

  const {
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    sendMessage,
  } = useStreamingChat({
    conversationId: activeConversationId,
    events,
  });

  useReturnDetection({
    enabled: !!activeConversationId,
    onReturn: useCallback(
      (awayMs: number) => {
        void sendMessage({
          text: `[System: The user has returned after being away for ${formatDuration(awayMs)}.]`,
          selectedText: null,
          chatContext: null,
          onClear: () => {},
        });
      },
      [sendMessage],
    ),
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

  const orbRef = useRef<FloatingOrbHandle>(null);

  const isOrbVisible = state.view !== "chat" && onboarding.onboardingDone;
  const orbMessage = useOrbMessage(events, isOrbVisible);

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      if (state.view === "chat") {
        setMessage(text);
      } else {
        orbRef.current?.openWithText(text);
      }
    },
    [state.view],
  );

  useEffect(() => {
    window.electronAPI?.ui.setAppReady?.(onboarding.onboardingDone);
  }, [onboarding.onboardingDone]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.voice.onTranscript?.((transcript) => {
      handleVoiceTranscript(transcript);
    });
    return () => unsubscribe?.();
  }, [handleVoiceTranscript]);

  useCanvasCommands(events);

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
  }, [message, selectedText, chatContext, sendMessage, setSelectedText, setChatContext]);

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

  const appReady = onboarding.onboardingDone;

  const chatColumnProps = useMemo<ChatColumnProps>(() => ({
    events,
    streaming: {
      text: streamingText,
      reasoningText,
      isStreaming,
      pendingUserMessageId,
      selfModMap,
    },
    composer: {
      message,
      setMessage,
      chatContext,
      setChatContext,
      selectedText,
      setSelectedText,
      canSubmit,
      onSend: handleSend,
    },
    scroll: {
      containerRef: scrollContainerRef,
      handleScroll,
      showScrollButton,
      scrollToBottom,
    },
    onboarding: {
      done: onboarding.onboardingDone,
      exiting: onboarding.onboardingExiting,
      isAuthenticated: onboarding.isAuthenticated,
      hasExpanded: onboarding.hasExpanded,
      splitMode: onboarding.splitMode,
      hasDiscoverySelections: onboarding.hasDiscoverySelections,
      key: onboarding.onboardingKey,
      stellaAnimationRef: onboarding.stellaAnimationRef,
      triggerFlash: onboarding.triggerFlash,
      startBirthAnimation: onboarding.startBirthAnimation,
      completeOnboarding: onboarding.completeOnboarding,
      handleEnterSplit: onboarding.handleEnterSplit,
      onDiscoveryConfirm: handleDiscoveryConfirm,
      onSelectionChange: onboarding.setHasDiscoverySelections,
      onDemoChange: handleDemoChange,
    },
    conversationId: activeConversationId,
    onCommandSelect: handleCommandSelect,
  }), [
    events,
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    message,
    chatContext,
    setChatContext,
    selectedText,
    setSelectedText,
    scrollContainerRef,
    handleScroll,
    showScrollButton,
    scrollToBottom,
    activeConversationId,
    onboarding.onboardingDone,
    onboarding.onboardingExiting,
    onboarding.isAuthenticated,
    canSubmit,
    handleSend,
    onboarding.hasExpanded,
    onboarding.splitMode,
    onboarding.hasDiscoverySelections,
    onboarding.onboardingKey,
    onboarding.stellaAnimationRef,
    onboarding.triggerFlash,
    onboarding.startBirthAnimation,
    onboarding.completeOnboarding,
    onboarding.handleEnterSplit,
    handleDiscoveryConfirm,
    onboarding.setHasDiscoverySelections,
    handleDemoChange,
    handleCommandSelect,
  ]);

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
      <MiniBridgeRelay
        conversationId={activeConversationId}
        events={events}
        streamingText={streamingText}
        reasoningText={reasoningText}
        isStreaming={isStreaming}
        pendingUserMessageId={pendingUserMessageId}
        sendMessage={sendMessage}
      />

      <div className="full-body">
        {appReady ? (
          <>
            <Sidebar
              onSignIn={() => setActiveDialog("auth")}
              onConnect={() => setActiveDialog("connect")}
              onSettings={() => setActiveDialog("settings")}
              onHome={() => setView('home')}
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
                  conversationId={activeConversationId ?? undefined}
                />
              )}

              <FloatingOrb
                ref={orbRef}
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

      {activeDialog === "auth" && (
        <Suspense fallback={null}>
          <AuthDialog open onOpenChange={(open) => { if (!open) setActiveDialog(null); }} />
        </Suspense>
      )}
      {activeDialog === "connect" && (
        <Suspense fallback={null}>
          <ConnectDialog
            open
            onOpenChange={(open) => { if (!open) setActiveDialog(null); }}
          />
        </Suspense>
      )}
      {activeDialog === "settings" && (
        <Suspense fallback={null}>
          <SettingsDialog
            open
            onOpenChange={(open) => { if (!open) setActiveDialog(null); }}
            onSignOut={() => {
              setActiveDialog(null);
              void secureSignOut();
            }}
          />
        </Suspense>
      )}

      {isDev && (
        <div className="dev-controls">
          <button
            className="onboarding-reset"
            onClick={onboarding.handleResetOnboarding}
          >
            Reset Onboarding
          </button>
          <button
            className="onboarding-reset"
            onClick={() => setActiveDialog("test")}
          >
            Test UI
          </button>
          <button
            className="onboarding-reset"
            onClick={() => window.electronAPI?.overlay.showNeri?.()}
          >
            Neri
          </button>
        </div>
      )}

      {isDev && activeDialog === "test" && (
        <Suspense fallback={null}>
          <SelfModTestDialog
            open
            onOpenChange={(open) => { if (!open) setActiveDialog(null); }}
          />
        </Suspense>
      )}

    </div>
  );
};

