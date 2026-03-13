import { useMemo, useState } from 'react'
import { useDevProjects } from '@/context/dev-projects-state'
import { Button } from '@/ui/button'
import { Spinner } from '@/ui/spinner'
import './dev-project-panel.css'

export function DevProjectPanel({ projectId }: { projectId: string }) {
  const { projects, isLoading, startProject, stopProject } = useDevProjects()
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState<'start' | 'stop' | null>(null)

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? null,
    [projects, projectId],
  )

  if (!project && isLoading) {
    return (
      <div className="dev-project-panel dev-project-panel--loading">
        <Spinner size="md" />
        <span>Loading project...</span>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="workspace-error">
        <div className="workspace-error-title">Project Unavailable</div>
        <div className="workspace-error-message">
          This project could not be found in your local workspace registry.
        </div>
      </div>
    )
  }

  const runtime = project.runtime
  const errorMessage = actionError ?? runtime.error ?? null

  const handleStart = async () => {
    setActionPending('start')
    setActionError(null)
    try {
      await startProject(project.id)
    } catch (error) {
      setActionError((error as Error).message)
    } finally {
      setActionPending(null)
    }
  }

  const handleStop = async () => {
    setActionPending('stop')
    setActionError(null)
    try {
      await stopProject(project.id)
    } catch (error) {
      setActionError((error as Error).message)
    } finally {
      setActionPending(null)
    }
  }

  if (runtime.status === 'running' && runtime.url) {
    return (
      <div className="dev-project-panel dev-project-panel--running">
        <div className="dev-project-toolbar">
          <div className="dev-project-toolbar-copy">
            <div className="dev-project-toolbar-title">{project.name}</div>
            <div className="dev-project-toolbar-url">{runtime.url}</div>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={handleStop}
            disabled={actionPending === 'stop'}
          >
            {actionPending === 'stop' ? 'Stopping...' : 'Stop'}
          </Button>
        </div>
        <div className="dev-project-frame-shell">
          <iframe
            title={`${project.name} preview`}
            src={runtime.url}
            className="dev-project-frame"
          />
        </div>
      </div>
    )
  }

  return (
    <div className="dev-project-panel">
        <div className="dev-project-empty-card">
        <div className="dev-project-kicker">Workspace Page</div>
        <h2 className="dev-project-title">{project.name}</h2>
        <p className="dev-project-description">
          Stella has this project ready, but nothing is running yet.
        </p>
        <div className="dev-project-meta-list">
          <div className="dev-project-meta-item">
            <span className="dev-project-meta-label">Location</span>
            <span className="dev-project-meta-value">{project.path}</span>
          </div>
          <div className="dev-project-meta-item">
            <span className="dev-project-meta-label">Added</span>
            <span className="dev-project-meta-value">
              {project.source === 'manual' ? 'Added manually' : 'Discovered automatically'}
            </span>
          </div>
        </div>
        {runtime.status === 'starting' && (
          <div className="dev-project-status-banner">
            <Spinner size="sm" />
            <span>Starting the dev server...</span>
          </div>
        )}
        {errorMessage && (
          <div className="dev-project-error-banner">
            <div className="dev-project-error-title">Unable to start this project</div>
            <div className="dev-project-error-message">{errorMessage}</div>
          </div>
        )}
        <div className="dev-project-actions">
          <Button
            type="button"
            variant="primary"
            onClick={handleStart}
            disabled={runtime.status === 'starting' || actionPending === 'start'}
          >
            {runtime.status === 'starting' || actionPending === 'start' ? 'Starting...' : 'Start'}
          </Button>
        </div>
      </div>
    </div>
  )
}
