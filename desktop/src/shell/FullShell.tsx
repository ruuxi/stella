import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { OnboardingDemo } from '@/global/onboarding/OnboardingCanvas'
import { useUiState } from '@/context/ui-state'
import { useWorkspace } from '@/context/workspace-state'
import { secureSignOut } from '@/global/auth/services/auth'
import { MiniBridgeRelay } from '@/shell/mini/MiniBridgeRelay'
import { useTheme } from '@/context/theme-context'
import { WorkspaceArea } from '@/app/workspace/WorkspaceArea'
import { ChatColumn } from '@/app/chat/ChatColumn'
import { useDiscoveryFlow } from '@/global/onboarding/DiscoveryFlow'
import { useOnboardingOverlay, OnboardingView } from '@/global/onboarding/OnboardingOverlay'
import { Sidebar } from '@/shell/sidebar/Sidebar'
import { FloatingOrb, type FloatingOrbHandle } from './FloatingOrb'
import { FullShellDialogs } from './full-shell-dialogs'
import { HeaderTabBar } from './HeaderTabBar'
import './full-shell.layout.css'
import './full-shell.panels.css'
import { ShiftingGradient } from './background/ShiftingGradient'
import { TitleBar } from './TitleBar'
import type { PersonalPage } from './HeaderTabBar'
import type { DialogType } from './full-shell-dialogs'
import { useFullShellChat } from './use-full-shell-chat'
import { useFullShellVoiceTranscript } from './use-full-shell-voice-transcript'
import { useLocalWorkspacePanels } from './use-local-workspace-panels'
import {
  dispatchStellaSendMessage,
  WORKSPACE_CREATION_TRIGGER_KIND,
} from '@/shared/lib/stella-send-message'

const OnboardingCanvas = lazy(() =>
  import('@/global/onboarding/OnboardingCanvas').then((m) => ({ default: m.OnboardingCanvas }))
)

export const FullShell = () => {
  const { state, setView } = useUiState()
  const activeConversationId = state.conversationId
  const { state: workspaceState, openPanel } = useWorkspace()
  const activePanel = workspaceState.activePanel
  const { gradientMode, gradientColor } = useTheme()
  const isDev = import.meta.env.DEV
  const orbRef = useRef<FloatingOrbHandle>(null)
  const [activeDemo, setActiveDemo] = useState<OnboardingDemo>(null)
  const [demoClosing, setDemoClosing] = useState(false)
  const demoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [activeDialog, setActiveDialog] = useState<DialogType>(null)
  const onboarding = useOnboardingOverlay()
  const { personalPages } = useLocalWorkspacePanels()
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

  const showChatView = useCallback(() => {
    setView('chat')
  }, [setView])

  const handleNewApp = useCallback(() => {
    dispatchStellaSendMessage({
      text: "The user wants to create a new workspace (app) added to the sidebar with its own content. Be concise and provide 2-4 suggestions and ideas.",
      uiVisibility: 'hidden',
      triggerKind: WORKSPACE_CREATION_TRIGGER_KIND,
      triggerSource: 'sidebar',
    })
    orbRef.current?.openChat()
    if (state.view === 'chat') {
      setView('home')
    }
  }, [setView, state.view])

  const handleDemoChange = useCallback((demo: OnboardingDemo) => {
    if (demo) {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current)
        demoCloseTimerRef.current = null
      }

      setDemoClosing(false)
      setActiveDemo(demo)
      return
    }

    setActiveDemo(null)
    setDemoClosing(true)
    demoCloseTimerRef.current = setTimeout(() => {
      setDemoClosing(false)
      demoCloseTimerRef.current = null
    }, 400)
  }, [])

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

  const handleResetMessages = useCallback(() => {
    if (!window.electronAPI?.system.resetMessages) {
      return
    }

    const shouldReset = window.confirm(
      'Delete all local sqlite/jsonl message storage for this app?',
    )
    if (!shouldReset) {
      return
    }

    void window.electronAPI.system
      .resetMessages()
      .then(() => {
        window.location.reload()
      })
      .catch((error) => {
        console.error(error)
      })
  }, [])

  const handleTabSelect = useCallback(
    (page: PersonalPage) => {
      openPanel({ name: page.panelName, title: page.title })
      setView('app')
    },
    [openPanel, setView],
  )

  useEffect(() => {
    window.electronAPI?.ui.setAppReady?.(onboarding.onboardingDone)
  }, [onboarding.onboardingDone])

  useEffect(() => {
    return () => {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current)
      }
    }
  }, [])

  const isOrbVisible = state.view !== 'chat' && onboarding.onboardingDone
  const appReady = onboarding.onboardingDone

  const showOnboardingDemos = activeDemo || demoClosing

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
        cancelCurrentStream={chat.conversation.cancelCurrentStream}
      />

      <div className="full-body">
        {appReady ? (
          <>
            <Sidebar
              activeView={state.view}
              onSignIn={showAuthDialog}
              onConnect={showConnectDialog}
              onSettings={showSettingsDialog}
              onHome={showHomeView}
              onChat={showChatView}
              onNewApp={handleNewApp}
            />

            <div className="content-area">
              {state.view !== 'chat' && personalPages.length > 0 && (
                <HeaderTabBar
                  activePanelName={activePanel?.name}
                  pages={personalPages}
                  onTabSelect={handleTabSelect}
                />
              )}

              {state.view === 'chat' ? (
                <ChatColumn
                  conversation={chat.conversation}
                  composer={chat.composer}
                  scroll={chat.scroll}
                  composerEntering={onboarding.onboardingExiting}
                  conversationId={activeConversationId}
                />
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
                events={chat.conversation.events}
                streamingText={chat.conversation.streamingText}
                isStreaming={chat.conversation.isStreaming}
                onSend={chat.conversation.sendContextlessMessage}
              />
            </div>
          </>
        ) : (
          <div className="onboarding-layout" data-split={onboarding.splitMode || undefined}>
            <OnboardingView
              hasExpanded={onboarding.hasExpanded}
              onboardingDone={onboarding.onboardingDone}
              onboardingExiting={onboarding.onboardingExiting}
              isAuthenticated={onboarding.isAuthenticated}
              splitMode={onboarding.splitMode}
              hasDiscoverySelections={onboarding.hasDiscoverySelections}
              stellaAnimationRef={onboarding.stellaAnimationRef}
              onboardingKey={onboarding.onboardingKey}
              triggerFlash={onboarding.triggerFlash}
              startBirthAnimation={onboarding.startBirthAnimation}
              completeOnboarding={onboarding.completeOnboarding}
              handleEnterSplit={onboarding.handleEnterSplit}
              onDiscoveryConfirm={handleDiscoveryConfirm}
              onSelectionChange={onboarding.setHasDiscoverySelections}
              onDemoChange={handleDemoChange}
            />
            {showOnboardingDemos && (
              <div className="onboarding-demo-area">
                <Suspense fallback={null}>
                  <OnboardingCanvas activeDemo={activeDemo} />
                </Suspense>
              </div>
            )}
          </div>
        )}
      </div>

      <FullShellDialogs
        activeDialog={activeDialog}
        isDev={isDev}
        onDialogOpenChange={handleDialogOpenChange}
        onResetMessages={handleResetMessages}
        onSignOut={handleSettingsSignOut}
        onResetOnboarding={onboarding.handleResetOnboarding}
        onShowTestDialog={showTestDialog}
        onShowTraceDialog={showTraceDialog}
      />
    </div>
  )
}
