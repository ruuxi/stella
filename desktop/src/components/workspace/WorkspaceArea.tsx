/**
 * WorkspaceArea: Main content area that always occupies the center of the layout.
 * Shows dashboard (default), canvas content, store, or onboarding demos.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspace, type CanvasPayload } from '@/app/state/workspace-state'
import { Spinner } from '@/components/spinner'
import type { OnboardingDemo } from '@/components/onboarding/OnboardingCanvas'
import type { ViewType } from '@/types/ui'

const PanelRenderer = lazy(() => import('@/components/canvas/renderers/panel'))
const AppframeRenderer = lazy(() => import('@/components/canvas/renderers/appframe'))
const StoreView = lazy(() => import('@/screens/full-shell/StoreView'))
const OnboardingCanvas = lazy(() =>
  import('@/components/onboarding/OnboardingCanvas').then((m) => ({ default: m.OnboardingCanvas }))
)

/** Extract port from a localhost URL, or null if not localhost. */
const getLocalhostPort = (url?: string): number | null => {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const port = parseInt(parsed.port, 10)
      return Number.isFinite(port) ? port : null
    }
  } catch { /* ignore */ }
  return null
}

type WorkspaceAreaProps = {
  view: ViewType
  isAuthenticated: boolean
  onboardingDone: boolean
  activeDemo: OnboardingDemo
  demoClosing: boolean
  onStoreBack: () => void
  onComposePrompt: (text: string) => void
}

export function WorkspaceArea({
  view,
  isAuthenticated,
  onboardingDone,
  activeDemo,
  demoClosing,
  onStoreBack,
  onComposePrompt,
}: WorkspaceAreaProps) {
  const { state, openCanvas, closeCanvas } = useWorkspace()
  const { canvas } = state

  // --- Dashboard auto-open logic (moved from FullShell) ---
  const isDashboardCanvas = canvas?.name === 'dashboard'
  const [dashboardDismissed, setDashboardDismissed] = useState(false)
  const prevCanvasRef = useRef<{ name?: string }>({})

  useEffect(() => {
    const wasName = prevCanvasRef.current.name
    prevCanvasRef.current = { name: canvas?.name }

    // Detect user closing the dashboard — mark as dismissed
    if (!canvas && wasName === 'dashboard') {
      setDashboardDismissed(true)
      return
    }

    // When a non-dashboard canvas opens, clear the dismissed flag
    // so dashboard returns when that canvas closes
    if (canvas && !isDashboardCanvas) {
      setDashboardDismissed(false)
      return
    }

    const ready = isAuthenticated && onboardingDone
    if (!ready || activeDemo || demoClosing) return
    if (canvas) return
    if (dashboardDismissed) return
    openCanvas({ name: 'dashboard' })
  }, [isAuthenticated, onboardingDone, canvas, isDashboardCanvas, activeDemo, demoClosing, dashboardDismissed, openCanvas])

  const handleCloseCanvas = useCallback(() => {
    const port = getLocalhostPort(canvas?.url)
    if (port) {
      window.electronAPI?.shellKillByPort(port)
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

  // Store view
  if (view === 'store') {
    return (
      <div className="workspace-area">
        <Suspense fallback={<div className="workspace-content workspace-content--full" />}>
          <StoreView onBack={onStoreBack} onComposePrompt={onComposePrompt} />
        </Suspense>
      </div>
    )
  }

  // Canvas content (non-dashboard shows header with close button)
  if (canvas && !isDashboardCanvas) {
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

  // Dashboard (default) — renders as full content with no header
  if (canvas && isDashboardCanvas) {
    return (
      <div className="workspace-area">
        <div className="workspace-content workspace-content--full">
          <Suspense fallback={<div className="workspace-placeholder"><Spinner size="md" /></div>}>
            <PanelRenderer canvas={canvas} />
          </Suspense>
        </div>
      </div>
    )
  }

  // Nothing active — empty workspace (dashboard dismissed or loading)
  return (
    <div className="workspace-area">
      <div className="workspace-content workspace-content--full">
        <div className="workspace-placeholder">
          <div className="workspace-placeholder-description">
            Your workspace is ready.
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Header sub-component for non-dashboard canvas ---

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
