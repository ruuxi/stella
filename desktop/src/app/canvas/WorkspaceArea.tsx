/**
 * WorkspaceArea: Main content area that always occupies the center of the layout.
 * Shows HomeView (default), workspace panels, or onboarding demos.
 */

import { lazy, Suspense, useCallback } from 'react'
import { useWorkspace, type WorkspacePanel } from '@/providers/workspace-state'
import { Spinner } from '@/ui/spinner'
import type { OnboardingDemo } from '@/app/onboarding/OnboardingCanvas'
import type { ViewType } from '@/types/ui'
import { HomeView } from '@/app/home/HomeView'
import './workspace.css'

const PanelRenderer = lazy(() => import('@/app/canvas/renderers/panel'))
const OnboardingCanvas = lazy(() =>
  import('@/app/onboarding/OnboardingCanvas').then((m) => ({ default: m.OnboardingCanvas }))
)


type WorkspaceAreaProps = {
  view: ViewType
  activeDemo: OnboardingDemo
  demoClosing: boolean
  conversationId?: string
}

export function WorkspaceArea({
  view,
  activeDemo,
  demoClosing,
  conversationId,
}: WorkspaceAreaProps) {
  const { state, closePanel } = useWorkspace()
  const { activePanel } = state

  const handleClosePanel = useCallback(() => {
    closePanel()
  }, [closePanel])

  // --- Render routing ---

  // Onboarding demos take priority
  if (activeDemo || demoClosing) {
    return (
      <div className="workspace-area">
        <Suspense fallback={<div className="workspace-content workspace-content--full"><Spinner size="md" /></div>}>
          <OnboardingCanvas activeDemo={activeDemo} />
        </Suspense>
      </div>
    )
  }

  // App view - active workspace panel with header
  if (view === 'app' && activePanel) {
    return (
      <div className="workspace-area">
        <WorkspaceHeader panel={activePanel} onClose={handleClosePanel} />
        <div className="workspace-content">
          <Suspense fallback={<div className="workspace-placeholder"><Spinner size="md" /></div>}>
            <PanelRenderer panel={activePanel} />
          </Suspense>
        </div>
      </div>
    )
  }

  // Home view (default)
  return (
    <div className="workspace-area">
      <div className="workspace-content workspace-content--full">
        <HomeView conversationId={conversationId} />
      </div>
    </div>
  )
}

function WorkspaceHeader({ panel, onClose }: { panel: WorkspacePanel; onClose: () => void }) {
  return (
    <div className="workspace-header">
      <span className="workspace-header-title">
        {panel.title ?? panel.name}
      </span>
      <button
        className="workspace-header-close"
        onClick={onClose}
        aria-label="Close panel"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

