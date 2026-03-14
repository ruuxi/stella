import { useState, useCallback } from 'react'
import { Button } from '@/ui/button'
import { Spinner } from '@/ui/spinner'
import type { WorkspacePanel } from '@/context/workspace-state'
import { useWorkspace } from '@/context/workspace-state'

export function HostedGamePanel({ panel }: { panel: WorkspacePanel }) {
  const { closePanel } = useWorkspace()
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleLoad = useCallback(() => {
    setIsLoading(false)
  }, [])

  const handleError = useCallback(() => {
    setIsLoading(false)
    setHasError(true)
  }, [])

  const handleCopyCode = useCallback(() => {
    if (!panel.joinCode) return
    void navigator.clipboard.writeText(panel.joinCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [panel.joinCode])

  if (!panel.gameUrl) {
    return (
      <div className="workspace-error">
        <div className="workspace-error-title">Game Unavailable</div>
        <div className="workspace-error-message">
          This game has not been deployed yet.
        </div>
      </div>
    )
  }

  if (hasError) {
    return (
      <div className="workspace-error">
        <div className="workspace-error-title">Game Error</div>
        <div className="workspace-error-message">
          The game could not be loaded. It may have been archived or removed.
        </div>
        <button className="workspace-error-retry" onClick={() => {
          setHasError(false)
          setIsLoading(true)
        }}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <div style={styles.toolbarInfo}>
          <div style={styles.gameName}>
            {panel.title || panel.name}
          </div>
          {panel.joinCode && (
            <button
              style={styles.joinCodeButton}
              onClick={handleCopyCode}
              title="Copy join code"
            >
              <span style={styles.joinCodeLabel}>Code:</span>
              <span style={styles.joinCodeValue}>{panel.joinCode}</span>
              <span style={styles.copyHint}>
                {copied ? 'Copied!' : 'Copy'}
              </span>
            </button>
          )}
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => closePanel()}
        >
          Close
        </Button>
      </div>

      <div style={styles.frameShell}>
        {isLoading && (
          <div style={styles.loadingOverlay}>
            <Spinner size="md" />
            <span>Loading game...</span>
          </div>
        )}
        <iframe
          title={`${panel.title || panel.name} game`}
          src={panel.gameUrl}
          style={{
            ...styles.frame,
            opacity: isLoading ? 0 : 1,
          }}
          onLoad={handleLoad}
          onError={handleError}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderBottom: '1px solid color-mix(in oklch, var(--foreground) 8%, transparent)',
    flexShrink: 0,
  },
  toolbarInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  gameName: {
    fontSize: 14,
    fontWeight: 500,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  joinCodeButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid color-mix(in oklch, var(--foreground) 12%, transparent)',
    background: 'color-mix(in oklch, var(--foreground) 4%, transparent)',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 12,
  },
  joinCodeLabel: {
    opacity: 0.5,
  },
  joinCodeValue: {
    fontFamily: 'monospace',
    fontWeight: 600,
    letterSpacing: '0.1em',
    fontSize: 13,
  },
  copyHint: {
    opacity: 0.4,
    fontSize: 11,
  },
  frameShell: {
    flex: 1,
    position: 'relative' as const,
    overflow: 'hidden',
  },
  loadingOverlay: {
    position: 'absolute' as const,
    inset: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    zIndex: 1,
  },
  frame: {
    width: '100%',
    height: '100%',
    border: 'none',
    transition: 'opacity 0.2s',
  },
}
