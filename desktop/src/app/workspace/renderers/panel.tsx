import { Suspense } from 'react'
import { generatedPages } from '@/app/registry'
import { Spinner } from '@/ui/spinner'
import { WorkspaceErrorBoundary } from '../WorkspaceErrorBoundary'
import {
  type DevProjectWorkspacePanel,
  type GeneratedPageWorkspacePanel,
  type HostedGameWorkspacePanel,
  type WorkspacePanel,
} from '@/context/workspace-state'
import { DevProjectPanel } from './dev-project-panel'
import { HostedGamePanel } from './hosted-game-panel'
import './workspace-renderers.css'

const DevProjectPanelRenderer = ({
  panel,
}: {
  panel: DevProjectWorkspacePanel
}) => (
  <div className="workspace-panel-wrap">
    <WorkspaceErrorBoundary>
      <div className="workspace-panel-content">
        <DevProjectPanel projectId={panel.projectId} />
      </div>
    </WorkspaceErrorBoundary>
  </div>
)

const HostedGamePanelRenderer = ({
  panel,
}: {
  panel: HostedGameWorkspacePanel
}) => (
  <div className="workspace-panel-wrap">
    <WorkspaceErrorBoundary>
      <div className="workspace-panel-content">
        <HostedGamePanel panel={panel} />
      </div>
    </WorkspaceErrorBoundary>
  </div>
)

const GeneratedPagePanelRenderer = ({
  panel,
}: {
  panel: GeneratedPageWorkspacePanel
}) => {
  const page = generatedPages.find((candidate) => candidate.id === panel.pageId)

  if (!page) {
    throw new Error(`Unknown generated page: ${panel.pageId}`)
  }

  const Page = page.component

  return (
    <div className="workspace-panel-wrap">
      <WorkspaceErrorBoundary>
        <div className="workspace-panel-content">
          <Suspense fallback={<div className="workspace-placeholder"><Spinner size="md" /></div>}>
            <Page />
          </Suspense>
        </div>
      </WorkspaceErrorBoundary>
    </div>
  )
}

const PanelRenderer = ({ panel }: { panel: WorkspacePanel }) => {
  switch (panel.kind) {
    case 'dev-project':
      return <DevProjectPanelRenderer panel={panel} />
    case 'hosted-game':
      return <HostedGamePanelRenderer panel={panel} />
    case 'generated-page':
      return <GeneratedPagePanelRenderer panel={panel} />
    default: {
      const exhaustiveCheck: never = panel
      return exhaustiveCheck
    }
  }
}

export default PanelRenderer
