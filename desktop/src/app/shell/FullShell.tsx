import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useOrbMessage } from '@/app/shell/hooks/use-orb-message'
import { useUiState } from '@/context/ui-state'
import { useWorkspace } from '@/context/workspace-state'
import { secureSignOut } from '@/app/auth/services/auth'
import { MiniBridgeRelay } from '@/app/shell/mini/MiniBridgeRelay'
import { useTheme } from '@/context/theme-context'
import { WorkspaceArea } from '../canvas/WorkspaceArea'
import { ChatColumn, type ChatColumnProps } from '../chat/ChatColumn'
import { useDiscoveryFlow } from '../onboarding/DiscoveryFlow'
import { useOnboardingOverlay } from '../onboarding/OnboardingOverlay'
import { Sidebar } from '../sidebar/Sidebar'
import { FloatingOrb, type FloatingOrbHandle } from './FloatingOrb'
import { FullShellDialogs } from './full-shell-dialogs'
import { HeaderTabBar } from './HeaderTabBar'
import './full-shell.layout.css'
import './full-shell.panels.css'
import { ShiftingGradient } from './background/ShiftingGradient'
import { TitleBar } from './TitleBar'
import type { PersonalPage } from './types'
import { useDemoAnimation } from './use-demo-animation'
import { useDialogManager } from './use-dialog-manager'
import { useFullShellChat } from './use-full-shell-chat'
import { useFullShellVoiceTranscript } from './use-full-shell-voice-transcript'
import { useLocalWorkspacePanels } from './use-local-workspace-panels'

export const FullShell = () => {
  const { state, setView } = useUiState()
  const activeConversationId = state.conversationId
  const { state: workspaceState, openPanel } = useWorkspace()
  const activePanel = workspaceState.activePanel
  const { gradientMode, gradientColor } = useTheme()
  const isDev = import.meta.env.DEV
  const orbRef = useRef<FloatingOrbHandle>(null)
  const onboarding = useOnboardingOverlay()
  const { personalPages } = useLocalWorkspacePanels()
  const { activeDemo, demoClosing, handleDemoChange } = useDemoAnimation()
  const { activeDialog, setActiveDialog } = useDialogManager()
  const { handleDiscoveryConfirm } = useDiscoveryFlow({
    conversationId: activeConversationId,
  })

  const chat = useFullShellChat({
    activeConversationId,
    activeView: state.view,
    isDev,
  })

  useFullShellVoiceTranscript({
    activeView: state.view,
    orbRef,
    setMessage: chat.composer.setMessage,
  })

  const showAuthDialog = useCallback(() => {
    setActiveDialog('auth')
  }, [setActiveDialog])

  const showConnectDialog = useCallback(() => {
    setActiveDialog('connect')
  }, [setActiveDialog])

  const showSettingsDialog = useCallback(() => {
    setActiveDialog('settings')
  }, [setActiveDialog])

  const showTestDialog = useCallback(() => {
    setActiveDialog('test')
  }, [setActiveDialog])

  const showTraceDialog = useCallback(() => {
    setActiveDialog('trace')
  }, [setActiveDialog])

  const showHomeView = useCallback(() => {
    setView('home')
  }, [setView])

  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setActiveDialog(null)
      }
    },
    [setActiveDialog],
  )

  const handleSettingsSignOut = useCallback(() => {
    setActiveDialog(null)
    void secureSignOut()
  }, [setActiveDialog])

  const handleTabSelect = useCallback(
    (view: 'home' | 'app' | 'chat', page?: PersonalPage) => {
      if (view === 'app' && page) {
        openPanel({ name: page.panelName, title: page.title })
        setView('app')
        return
      }

      setView(view)
    },
    [openPanel, setView],
  )

  useEffect(() => {
    window.electronAPI?.ui.setAppReady?.(onboarding.onboardingDone)
  }, [onboarding.onboardingDone])

  const isOrbVisible = state.view !== 'chat' && onboarding.onboardingDone
  const orbMessage = useOrbMessage(chat.conversation.events, isOrbVisible)
  const appReady = onboarding.onboardingDone

  const chatColumnProps = useMemo<ChatColumnProps>(
    () => ({
      events: chat.conversation.events,
      streaming: {
        text: chat.conversation.streamingText,
        reasoningText: chat.conversation.reasoningText,
        isStreaming: chat.conversation.isStreaming,
        pendingUserMessageId: chat.conversation.pendingUserMessageId,
        selfModMap: chat.conversation.selfModMap,
      },
      history: {
        hasOlderEvents: chat.conversation.hasOlderEvents,
        isLoadingOlder: chat.conversation.isLoadingOlder,
        isInitialLoading: chat.conversation.isInitialLoading,
      },
      composer: {
        message: chat.composer.message,
        setMessage: chat.composer.setMessage,
        chatContext: chat.composer.chatContext,
        setChatContext: chat.composer.setChatContext,
        selectedText: chat.composer.selectedText,
        setSelectedText: chat.composer.setSelectedText,
        canSubmit: chat.composer.canSubmit,
        onSend: chat.composer.handleSend,
      },
      scrollContainerRef: chat.scroll.scrollContainerRef,
      setScrollContainerElement: chat.scroll.setScrollContainerElement,
      canVirtualize: chat.scroll.hasScrollElement,
      onScroll: chat.scroll.handleScroll,
      showScrollButton: chat.scroll.showScrollButton,
      scrollToBottom: chat.scroll.scrollToBottom,
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
      onCommandSelect: chat.composer.handleCommandSelect,
    }),
    [
      activeConversationId,
      chat.composer.canSubmit,
      chat.composer.chatContext,
      chat.composer.handleCommandSelect,
      chat.composer.handleSend,
      chat.composer.message,
      chat.composer.selectedText,
      chat.composer.setChatContext,
      chat.composer.setMessage,
      chat.composer.setSelectedText,
      chat.conversation.events,
      chat.conversation.hasOlderEvents,
      chat.conversation.isInitialLoading,
      chat.conversation.isLoadingOlder,
      chat.conversation.isStreaming,
      chat.conversation.pendingUserMessageId,
      chat.conversation.reasoningText,
      chat.conversation.selfModMap,
      chat.conversation.streamingText,
      chat.scroll.handleScroll,
      chat.scroll.scrollContainerRef,
      chat.scroll.setScrollContainerElement,
      chat.scroll.hasScrollElement,
      chat.scroll.scrollToBottom,
      chat.scroll.showScrollButton,
      handleDemoChange,
      handleDiscoveryConfirm,
      onboarding.completeOnboarding,
      onboarding.handleEnterSplit,
      onboarding.hasDiscoverySelections,
      onboarding.hasExpanded,
      onboarding.isAuthenticated,
      onboarding.onboardingDone,
      onboarding.onboardingExiting,
      onboarding.onboardingKey,
      onboarding.setHasDiscoverySelections,
      onboarding.splitMode,
      onboarding.startBirthAnimation,
      onboarding.stellaAnimationRef,
      onboarding.triggerFlash,
    ],
  )

  return (
    <div className="window-shell full">
      <TitleBar />
      <ShiftingGradient mode={gradientMode} colorMode={gradientColor} />
      <MiniBridgeRelay
        conversationId={activeConversationId}
        events={chat.conversation.events}
        streamingText={chat.conversation.streamingText}
        reasoningText={chat.conversation.reasoningText}
        isStreaming={chat.conversation.isStreaming}
        pendingUserMessageId={chat.conversation.pendingUserMessageId}
        sendMessage={chat.conversation.sendMessage}
      />

      <div className="full-body">
        {appReady ? (
          <>
            <Sidebar
              onSignIn={showAuthDialog}
              onConnect={showConnectDialog}
              onSettings={showSettingsDialog}
              onHome={showHomeView}
            />

            <div className="content-area">
              <HeaderTabBar
                activeView={state.view}
                activePanelName={activePanel?.name}
                pages={personalPages}
                onTabSelect={handleTabSelect}
              />

              {state.view === 'chat' ? (
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
                isStreaming={chat.conversation.isStreaming}
                onSend={chat.conversation.sendContextlessMessage}
              />
            </div>
          </>
        ) : (
          <ChatColumn {...chatColumnProps} />
        )}
      </div>

      <FullShellDialogs
        activeDialog={activeDialog}
        isDev={isDev}
        onDialogOpenChange={handleDialogOpenChange}
        onSignOut={handleSettingsSignOut}
        onResetOnboarding={onboarding.handleResetOnboarding}
        onShowTestDialog={showTestDialog}
        onShowTraceDialog={showTraceDialog}
      />
    </div>
  )
}
