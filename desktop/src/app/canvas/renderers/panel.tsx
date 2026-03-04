import { useState, useEffect, useCallback, useRef, type ComponentType } from 'react'
import { CanvasErrorBoundary } from '../CanvasErrorBoundary'
import { Spinner } from '@/ui/spinner'
import type { CanvasPayload } from '@/providers/workspace-state'

const PANEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const PANEL_IMPORT_ATTEMPTS = 3
const PANEL_IMPORT_BASE_DELAY_MS = 200
const PANEL_IMPORT_MAX_DELAY_MS = 1_000

type PanelComponent = ComponentType<Record<string, unknown>>

class MissingPanelNameError extends Error {
  readonly _tag = 'MissingPanelNameError'

  constructor(message: string) {
    super(message)
    this.name = 'MissingPanelNameError'
  }
}

class InvalidPanelNameError extends Error {
  readonly _tag = 'InvalidPanelNameError'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidPanelNameError'
  }
}

class PanelImportError extends Error {
  readonly _tag = 'PanelImportError'
  readonly panelName: string
  override readonly cause: unknown

  constructor(panelName: string, cause: unknown) {
    super(formatUnknownError(cause))
    this.name = 'PanelImportError'
    this.panelName = panelName
    this.cause = cause
  }
}

class InvalidPanelModuleError extends Error {
  readonly _tag = 'InvalidPanelModuleError'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidPanelModuleError'
  }
}

const normalizePanelName = (value: string): string | null => {
  const base = value.trim().replace(/\.tsx$/i, '')
  if (!PANEL_NAME_PATTERN.test(base)) {
    return null
  }
  return base
}

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Unknown error'
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const getPanelImportBackoffMs = (attempt: number): number =>
  Math.min(
    PANEL_IMPORT_MAX_DELAY_MS,
    PANEL_IMPORT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
  )

const loadPanelComponent = async (
  panelName: string,
): Promise<{ normalizedName: string; component: PanelComponent }> => {
  if (!panelName) {
    throw new MissingPanelNameError('No panel name specified')
  }

  const normalizedName = normalizePanelName(panelName)
  if (!normalizedName) {
    throw new InvalidPanelNameError('Invalid panel name. Use letters, numbers, "_" or "-".')
  }

  let lastError: unknown = null
  for (let attempt = 1; attempt <= PANEL_IMPORT_ATTEMPTS; attempt += 1) {
    try {
      // Try folder convention first (pages/{name}/index.tsx), then flat file ({name}.tsx)
      let mod: { default?: unknown } | undefined
      try {
        mod = await import(/* @vite-ignore */ `/src/app/home/pages/${normalizedName}/index.tsx?t=${Date.now()}`)
      } catch {
        // Fall through to flat file.
      }
      if (!mod?.default) {
        const file = `${normalizedName}.tsx`
        mod = await import(/* @vite-ignore */ `/src/app/home/pages/${file}?t=${Date.now()}`)
      }

      if (typeof mod?.default !== 'function') {
        throw new InvalidPanelModuleError('Panel module does not export a default component.')
      }

      return {
        normalizedName,
        component: mod.default as PanelComponent,
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(formatUnknownError(cause))
      const wrappedError = error instanceof InvalidPanelModuleError
        ? error
        : new PanelImportError(normalizedName, error)
      lastError = wrappedError

      if (!(wrappedError instanceof PanelImportError) || attempt >= PANEL_IMPORT_ATTEMPTS) {
        break
      }

      await sleep(getPanelImportBackoffMs(attempt))
    }
  }

  throw lastError ?? new PanelImportError(normalizedName, new Error('Unknown panel load error'))
}

const toPanelLoadMessage = (error: unknown): string => {
  if (error instanceof MissingPanelNameError) return error.message
  if (error instanceof InvalidPanelNameError) return error.message
  if (error instanceof InvalidPanelModuleError) return error.message
  if (error instanceof PanelImportError) {
    return `Failed to load panel: ${formatUnknownError(error.cause)}`
  }
  return `Failed to load panel: ${formatUnknownError(error)}`
}

const PanelRenderer = ({ canvas }: { canvas: CanvasPayload }) => {
  const { name } = canvas
  const [Component, setComponent] = useState<PanelComponent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const retryKeyRef = useRef(0)

  const loadModule = useCallback(async () => {
    setLoading(true)
    setError(null)
    setComponent(null)

    try {
      const loaded = await loadPanelComponent(name)
      setComponent(() => loaded.component)
      setLoading(false)
      return
    } catch (caughtError) {
      const message = toPanelLoadMessage(caughtError)
      setError(message)
      if (caughtError instanceof PanelImportError) {
        window.dispatchEvent(
          new CustomEvent('stella:panel-load-failed', {
            detail: { panelName: caughtError.panelName, error: message },
          }),
        )
      }
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
    return (
      <div className="canvas-error">
        <div className="canvas-error-title">Panel Error</div>
        <div className="canvas-error-message">Panel component is unavailable.</div>
        <button className="canvas-error-retry" onClick={handleRetry}>
          Retry
        </button>
      </div>
    )
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


