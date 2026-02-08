import { useState, useEffect, useCallback, useRef } from 'react'
import { registerCanvas } from '../canvas-registry'
import { CanvasErrorBoundary } from '../CanvasErrorBoundary'
import { Spinner } from '@/components/spinner'
import type { CanvasPayload } from '@/app/state/canvas-state'

type PanelData = {
  file?: string
  [key: string]: unknown
}

const normalizeData = (raw: unknown): PanelData => {
  if (raw && typeof raw === 'object') return raw as PanelData
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('{')) {
      try { return JSON.parse(trimmed) as PanelData } catch { /* not JSON */ }
    }
    return { file: trimmed }
  }
  return {}
}

const PanelRenderer = ({ canvas }: { canvas: CanvasPayload }) => {
  const data = normalizeData(canvas.data)
  const file = data.file
  const [Component, setComponent] = useState<React.ComponentType<Record<string, unknown>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const retryKeyRef = useRef(0)

  const loadModule = useCallback(async () => {
    if (!file) {
      setError('No panel file specified in data.file')
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    try {
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
  }, [file])

  useEffect(() => {
    void loadModule()
  }, [loadModule])

  const handleRetry = useCallback(() => {
    retryKeyRef.current++
    void loadModule()
  }, [loadModule])

  if (loading) {
    return (
      <div className="canvas-generated-loading">
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

  // Pass extra data props (excluding file) to the panel component
  const componentProps: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (k !== 'file') componentProps[k] = v
  }

  return (
    <div className="canvas-generated-wrap">
      <CanvasErrorBoundary key={retryKeyRef.current} onRetry={handleRetry}>
        <div className="canvas-generated-content">
          <Component {...componentProps} />
        </div>
      </CanvasErrorBoundary>
    </div>
  )
}

registerCanvas('panel', PanelRenderer)

export default PanelRenderer
