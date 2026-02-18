import { useState, useEffect, useCallback, useRef } from 'react'
import { CanvasErrorBoundary } from '../CanvasErrorBoundary'
import { Spinner } from '@/components/spinner'
import type { CanvasPayload } from '@/app/state/canvas-state'

const PANEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

const normalizePanelName = (value: string): string | null => {
  const base = value.trim().replace(/\.tsx$/i, '')
  if (!PANEL_NAME_PATTERN.test(base)) {
    return null
  }
  return base
}

const PanelRenderer = ({ canvas }: { canvas: CanvasPayload }) => {
  const { name } = canvas
  const [Component, setComponent] = useState<React.ComponentType<Record<string, unknown>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const retryKeyRef = useRef(0)

  const loadModule = useCallback(async () => {
    if (!name) {
      setError('No panel name specified')
      setLoading(false)
      return
    }

    const normalizedName = normalizePanelName(name)
    if (!normalizedName) {
      setError('Invalid panel name. Use letters, numbers, "_" or "-".')
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    try {
      const file = `${normalizedName}.tsx`
      const mod = await import(/* @vite-ignore */ `/workspace/panels/${file}?t=${Date.now()}`)
      const comp = mod.default
      if (typeof comp !== 'function') {
        setError('Panel module does not export a default component.')
        setLoading(false)
        return
      }
      setComponent(() => comp)
      setLoading(false)
    } catch (err) {
      setError(`Failed to load panel: ${(err as Error).message}`)
      setLoading(false)
    }
  }, [name])

  useEffect(() => {
    void loadModule()
  }, [loadModule])

  const handleRetry = useCallback(() => {
    retryKeyRef.current++
    void loadModule()
  }, [loadModule])

  if (loading) {
    return (
      <div className="canvas-vite-loading">
        <Spinner size="md" />
        <span>Loading panel...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="canvas-error">
        <div className="canvas-error-title">Panel Error</div>
        <div className="canvas-error-message">{error}</div>
        <button className="canvas-error-retry" onClick={handleRetry}>
          Retry
        </button>
      </div>
    )
  }

  if (!Component) {
    return <div className="canvas-renderer-empty">No component loaded</div>
  }

  return (
    <div className="canvas-vite-wrap">
      <CanvasErrorBoundary key={retryKeyRef.current} onRetry={handleRetry}>
        <div className="canvas-vite-content">
          <Component />
        </div>
      </CanvasErrorBoundary>
    </div>
  )
}

export default PanelRenderer
