import { WorkspaceErrorBoundary } from '../WorkspaceErrorBoundary'
import type { WorkspacePanel } from '@/context/workspace-state'
import { DevProjectPanel } from './dev-project-panel'
import { HostedGamePanel } from './hosted-game-panel'
import './workspace-renderers.css'

const DevProjectPanelRenderer = ({ panel }: { panel: WorkspacePanel }) => {
  if (!panel.projectId) {
    return (
      <div className="workspace-error">
        <div className="workspace-error-title">Project Error</div>
        <div className="workspace-error-message">Project information is unavailable.</div>
      </div>
    )
  }

  return (
    <div className="workspace-panel-wrap">
      <WorkspaceErrorBoundary>
        <div className="workspace-panel-content">
          <DevProjectPanel projectId={panel.projectId} />
        </div>
      </WorkspaceErrorBoundary>
    </div>
  )
}

const HostedGamePanelRenderer = ({ panel }: { panel: WorkspacePanel }) => (
  <div className="workspace-panel-wrap">
    <WorkspaceErrorBoundary>
      <div className="workspace-panel-content">
        <HostedGamePanel panel={panel} />
      </div>
    </WorkspaceErrorBoundary>
  </div>
)

const UnsupportedPanelRenderer = () => (
  <div className="workspace-error">
    <div className="workspace-error-title">Workspace Error</div>
    <div className="workspace-error-message">
      This workspace surface is no longer supported.
    </div>
  </div>
)

const PanelRenderer = ({ panel }: { panel: WorkspacePanel }) => {
  if (panel.kind === 'hosted-game') {
    return <HostedGamePanelRenderer panel={panel} />
  }

  if (panel.kind === 'dev-project') {
    return <DevProjectPanelRenderer panel={panel} />
  }

  return <UnsupportedPanelRenderer />
}

export default PanelRenderer


