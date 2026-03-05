/**
 * WorkspaceArea: Main content area that always occupies the center of the layout.
 * Shows HomeView (default), canvas/app content, or onboarding demos.
 */

import { lazy, Suspense, useCallback } from 'react'
import { useWorkspace, type CanvasPayload } from '@/providers/workspace-state'
import { Spinner } from '@/ui/spinner'
import type { OnboardingDemo } from '@/app/onboarding/OnboardingCanvas'
import type { ViewType } from '@/types/ui'
import { HomeView } from '@/app/home/HomeView'
import { getLocalhostPort } from '@/lib/utils'

const PanelRenderer = lazy(() => import('@/app/canvas/renderers/panel'))
const AppframeRenderer = lazy(() => import('@/app/canvas/renderers/appframe'))
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
  const { state, closeCanvas } = useWorkspace()
  const { canvas } = state

  const handleCloseCanvas = useCallback(() => {
    const port = getLocalhostPort(canvas?.url)
    if (port) {
      window.electronAPI?.system.shellKillByPort(port)
    }
    closeCanvas()
  }, [canvas, closeCanvas])

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

  // App view — canvas content with header
  if (view === 'app' && canvas) {
    return (
      <div className="workspace-area">
        <CanvasHeader canvas={canvas} onClose={handleCloseCanvas} />
        <div className="workspace-content">
          <Suspense fallback={<div className="workspace-placeholder"><Spinner size="md" /></div>}>
            {canvas.url
              ? <AppframeRenderer canvas={canvas} />
              : <PanelRenderer canvas={canvas} />
            }
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

// --- Header sub-component for canvas ---

function CanvasHeader({ canvas, onClose }: { canvas: CanvasPayload; onClose: () => void }) {
  return (
    <div className="workspace-header">
      <span className="workspace-header-title">
        {canvas.title ?? canvas.name}
      </span>
      <button
        className="workspace-header-close"
        onClick={onClose}
        aria-label="Close canvas"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

