import { WorkspaceErrorBoundary } from '../WorkspaceErrorBoundary'
import {
  type DevProjectWorkspacePanel,
  type WorkspacePanel,
} from '@/context/workspace-state'
import { DevProjectPanel } from './dev-project-panel'
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

const PanelRenderer = ({ panel }: { panel: WorkspacePanel }) => (
  <DevProjectPanelRenderer panel={panel} />
)

export default PanelRenderer
