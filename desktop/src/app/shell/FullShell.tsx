import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { OnboardingDemo } from '@/app/onboarding/OnboardingCanvas'
import { useOrbMessage } from '@/app/shell/hooks/use-orb-message'
import { useUiState } from '@/context/ui-state'
import { useWorkspace } from '@/context/workspace-state'
import { secureSignOut } from '@/app/auth/services/auth'
import { MiniBridgeRelay } from '@/app/shell/mini/MiniBridgeRelay'
import { useTheme } from '@/context/theme-context'
import { WorkspaceArea } from '../canvas/WorkspaceArea'
import { ChatColumn } from '../chat/ChatColumn'
import { useDiscoveryFlow } from '../onboarding/DiscoveryFlow'
import { useOnboardingOverlay, OnboardingView } from '../onboarding/OnboardingOverlay'
import { Sidebar } from '../sidebar/Sidebar'
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

const OnboardingCanvas = lazy(() =>
  import('../onboarding/OnboardingCanvas').then((m) => ({ default: m.OnboardingCanvas }))
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

  useEffect(() => {
    return () => {
      if (demoCloseTimerRef.current) {
        clearTimeout(demoCloseTimerRef.current)
      }
    }
  }, [])

  const isOrbVisible = state.view !== 'chat' && onboarding.onboardingDone
  const orbMessage = useOrbMessage(chat.conversation.events, isOrbVisible)
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
                bubbleText={orbMessage.text}
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
