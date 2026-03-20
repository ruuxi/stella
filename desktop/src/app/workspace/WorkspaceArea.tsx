/**
 * WorkspaceArea: Main content area that always occupies the center of the layout.
 * Shows HomeView (default), workspace panels, or onboarding demos.
 */

import { lazy, Suspense } from 'react'
import { useWorkspace } from '@/context/workspace-state'
import { Spinner } from '@/ui/spinner'
import type { OnboardingDemo } from '@/global/onboarding/OnboardingCanvas'
import type { ViewType } from '@/shared/contracts/ui'
import { HomeView } from '@/app/home/HomeView'
import './workspace.css'

const PanelRenderer = lazy(() => import('@/app/workspace/renderers/panel'))
const OnboardingCanvas = lazy(() =>
  import('@/global/onboarding/OnboardingCanvas').then((m) => ({ default: m.OnboardingCanvas }))
)
const StoreView = lazy(() => import('@/global/store/StoreView'))


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
  const { state } = useWorkspace()
  const { activePanel } = state

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

  // App view - active workspace panel (title + dismiss live in the sidebar)
  if (view === 'app' && activePanel) {
    return (
      <div className="workspace-area">
        <div className="workspace-content workspace-content--full">
          <Suspense fallback={<div className="workspace-placeholder"><Spinner size="md" /></div>}>
            <PanelRenderer panel={activePanel} />
          </Suspense>
        </div>
      </div>
    )
  }

  // Store view
  if (view === 'store') {
    return (
      <div className="workspace-area">
        <div className="workspace-content workspace-content--full">
          <Suspense fallback={<div className="workspace-placeholder"><Spinner size="md" /></div>}>
            <StoreView />
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

