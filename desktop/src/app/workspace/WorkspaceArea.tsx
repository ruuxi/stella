import { lazy, Suspense } from "react"
import { useWorkspace } from "@/context/workspace-state"
import { Spinner } from "@/ui/spinner"
import type { OnboardingDemo } from "@/global/onboarding/OnboardingCanvas"
import type { ViewType } from "@/shared/contracts/ui"
import "./workspace.css"

const PanelRenderer = lazy(() => import("@/app/workspace/renderers/panel"))
const OnboardingCanvas = lazy(() =>
  import("@/global/onboarding/OnboardingCanvas").then((m) => ({ default: m.OnboardingCanvas })),
)
const StoreView = lazy(() => import("@/global/store/StoreView"))

type WorkspaceAreaProps = {
  view: ViewType
  activeDemo: OnboardingDemo
  demoClosing: boolean
}

export function WorkspaceArea({
  view,
  activeDemo,
  demoClosing,
}: WorkspaceAreaProps) {
  const { state } = useWorkspace()
  const { activePanel } = state
  const showOnboarding = activeDemo !== null || demoClosing

  if (showOnboarding) {
    return (
      <div className="workspace-area">
        <Suspense
          fallback={
            <div className="workspace-content workspace-content--full">
              <Spinner size="md" />
            </div>
          }
        >
          <OnboardingCanvas activeDemo={activeDemo} />
        </Suspense>
      </div>
    )
  }

  if (view === "app" && activePanel) {
    return (
      <div className="workspace-area">
        <div className="workspace-content workspace-content--full">
          <Suspense
            fallback={
              <div className="workspace-placeholder">
                <Spinner size="md" />
              </div>
            }
          >
            <PanelRenderer panel={activePanel} />
          </Suspense>
        </div>
      </div>
    )
  }

  if (view === "store") {
    return (
      <div className="workspace-area">
        <div className="workspace-content workspace-content--full">
          <Suspense
            fallback={
              <div className="workspace-placeholder">
                <Spinner size="md" />
              </div>
            }
          >
            <StoreView />
          </Suspense>
        </div>
      </div>
    )
  }

  if (view === "chat" || view === "social" || view === "app") {
    // Chat/social are handled by FullShellRuntime.
    return null
  }

  const exhaustiveCheck: never = view
  return exhaustiveCheck
}
