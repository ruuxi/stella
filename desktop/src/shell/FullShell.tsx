import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { GeneratedPage } from '@/app/registry'
import { ChatColumn } from '@/app/chat/ChatColumn'
import { WorkspaceArea } from '@/app/workspace/WorkspaceArea'
import { useDevProjects } from '@/context/dev-projects-state'
import { useTheme } from '@/context/theme-context'
import { useUiState } from '@/context/ui-state'
import { useWorkspace } from '@/context/workspace-state'
import { secureSignOut } from '@/global/auth/services/auth'
import type { OnboardingDemo } from '@/global/onboarding/OnboardingCanvas'
import { useDiscoveryFlow } from '@/global/onboarding/DiscoveryFlow'
import { useOnboardingOverlay, OnboardingView } from '@/global/onboarding/OnboardingOverlay'
import { SocialView } from '@/app/social/SocialView'
import { MiniBridgeRelay } from '@/shell/mini/MiniBridgeRelay'
import { Sidebar } from '@/shell/sidebar/Sidebar'
import {
  dispatchStellaSendMessage,
  WORKSPACE_CREATION_TRIGGER_KIND,
} from '@/shared/lib/stella-send-message'
import { ShiftingGradient } from './background/ShiftingGradient'
import { FloatingOrb, type FloatingOrbHandle } from './FloatingOrb'
import { FullShellDialogs } from './full-shell-dialogs'
import type { DialogType } from './full-shell-dialogs'
import './full-shell.layout.css'
import { TitleBar } from './TitleBar'
import { useFullShellChat } from './use-full-shell-chat'
import { useFullShellVoiceTranscript } from './use-full-shell-voice-transcript'

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
  const { projects, pickProjectDirectory } = useDevProjects()
  const { handleDiscoveryConfirm, dashboardState } = useDiscoveryFlow({
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

  const showStoreView = useCallback(() => {
    setView('store')
  }, [setView])

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

  const showSocialView = useCallback(() => {
    setView('social')
  }, [setView])

  const handlePageSelect = useCallback(
    (page: GeneratedPage) => {
      openPanel({
        kind: 'generated-page',
        name: page.id,
        title: page.title,
        pageId: page.id,
      })
      setView('app')
    },
    [openPanel, setView],
  )

  const handleNewAppAskStella = useCallback(() => {
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

  const handleProjectSelect = useCallback(
    (project: (typeof projects)[number]) => {
      openPanel({
        name: `dev-project:${project.id}`,
        title: project.name,
        kind: 'dev-project',
        projectId: project.id,
      })
      setView('app')
    },
    [openPanel, setView],
  )

  const handleNewAppLocalProject = useCallback(async () => {
    const project = await pickProjectDirectory()
    if (!project) {
      return
    }

    handleProjectSelect(project)
  }, [handleProjectSelect, pickProjectDirectory])

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

  const isOrbVisible = state.view !== 'chat' && state.view !== 'social' && onboarding.onboardingDone
  const appReady = onboarding.onboardingDone
  const activeProjectId = activePanel?.kind === 'dev-project' ? activePanel.projectId : null
  const activePageId = activePanel?.kind === 'generated-page' ? activePanel.pageId : null

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
              onStore={showStoreView}
              onHome={showHomeView}
              onChat={showChatView}
              onSocial={showSocialView}
              onNewAppAskStella={handleNewAppAskStella}
              onNewAppLocalProject={handleNewAppLocalProject}
              activePageId={activePageId}
              onPageSelect={handlePageSelect}
              dashboardState={dashboardState}
              projects={projects}
              activeProjectId={activeProjectId}
              onProjectSelect={handleProjectSelect}
            />

            <div className="content-area">
              {state.view === 'chat' ? (
                <ChatColumn
                  conversation={chat.conversation}
                  composer={chat.composer}
                  scroll={chat.scroll}
                  composerEntering={onboarding.onboardingExiting}
                  conversationId={activeConversationId}
                />
              ) : state.view === 'social' ? (
                <SocialView onSignIn={showAuthDialog} />
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
