import { useState, useEffect, useCallback, useRef } from 'react'
import { registerCanvas } from '../canvas-registry'
import { CanvasErrorBoundary } from '../CanvasErrorBoundary'
import { compile } from '../compiler/compile'
import { evaluate } from '../compiler/evaluate'
import { Spinner } from '@/components/spinner'
import type { CanvasPayload } from '@/app/state/canvas-state'

type GeneratedData = {
  file?: string
  source?: string
  code?: string
  [key: string]: unknown
}

/** Normalize canvas data — if it arrives as a JSON string, parse it first */
const normalizeData = (raw: unknown): GeneratedData => {
  if (raw && typeof raw === 'object') return raw as GeneratedData
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('{')) {
      try { return JSON.parse(trimmed) as GeneratedData } catch { /* not JSON */ }
    }
    // Plain string = inline source
    return { source: trimmed }
  }
  return {}
}

const GeneratedRenderer = ({ canvas }: { canvas: CanvasPayload }) => {
  const data = normalizeData(canvas.data)
  const file = data.file
  const inlineSource = data.source ?? data.code ?? ''
  const [source, setSource] = useState<string>(file ? '' : inlineSource)
  const [Component, setComponent] = useState<React.ComponentType<Record<string, unknown>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [loading, setLoading] = useState(!!file)
  const lastSourceRef = useRef<string | null>(null)
  const retryKeyRef = useRef(0)
  const cleanupRef = useRef<(() => void) | null>(null)

  // Read source from file and watch for changes
  useEffect(() => {
    if (!file) return

    const api = window.electronAPI
    if (!api?.readCanvasFile) {
      setError('Canvas file reading not available (not running in Electron).')
      setLoading(false)
      return
    }

    let cancelled = false

    const loadFile = async () => {
      const result = await api.readCanvasFile(file)
      if (cancelled) return
      if (result.error) {
        setError(result.error)
        setLoading(false)
        return
      }
      setSource(result.content ?? '')
      setLoading(false)
    }

    void loadFile()

    // Watch for file changes
    if (api.watchCanvasFile && api.onCanvasFileChanged) {
      void api.watchCanvasFile(file)
      const unsub = api.onCanvasFileChanged((changedFile) => {
        if (changedFile === file) {
          void loadFile()
        }
      })
      cleanupRef.current = () => {
        unsub()
        api.unwatchCanvasFile?.(file)
      }
    }

    return () => {
      cancelled = true
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [file])

  // For inline source changes (no file)
  useEffect(() => {
    if (file) return
    setSource(inlineSource)
  }, [file, inlineSource])

  const doCompile = useCallback(async (src: string) => {
    if (!src.trim()) {
      setError('No source code provided.')
      return
    }

    setCompiling(true)
    setError(null)

    const compileResult = await compile(src)

    if (compileResult.error) {
      setError(`Compile error: ${compileResult.error}`)
      setCompiling(false)
      return
    }
    if (!compileResult.code) {
      setError('Compile succeeded but produced no code.')
      setCompiling(false)
      return
    }

    const evalResult = evaluate(compileResult.code)

    if (evalResult.error) {
      setError(evalResult.error)
      setCompiling(false)
      return
    }
    if (!evalResult.component) {
      setError('Compiled module did not export a default component.')
      setCompiling(false)
      return
    }

    setComponent(() => evalResult.component)
    setCompiling(false)
  }, [])

  // Compile on source change (lastSourceRef starts as null so first mount always runs)
  useEffect(() => {
    if (source === lastSourceRef.current) return
    lastSourceRef.current = source
    void doCompile(source)
  }, [source, doCompile])

  const handleRetry = useCallback(() => {
    retryKeyRef.current++
    lastSourceRef.current = ''
    if (file) {
      // Re-read from file
      setLoading(true)
      const api = window.electronAPI
      if (api?.readCanvasFile) {
        void api.readCanvasFile(file).then((result) => {
          if (result.error) {
            setError(result.error)
            setLoading(false)
            return
          }
          setSource(result.content ?? '')
          setLoading(false)
        })
      }
    } else {
      void doCompile(source)
    }
  }, [file, source, doCompile])

  if (loading) {
    return (
      <div className="canvas-generated-loading">
        <Spinner size="md" />
        <span>Loading component...</span>
      </div>
    )
  }

  if (compiling) {
    return (
      <div className="canvas-generated-loading">
        <Spinner size="md" />
        <span>Compiling component...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="canvas-error">
        <div className="canvas-error-title">Compilation Error</div>
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

  // Pass extra data props (excluding source/file) to the generated component
  const componentProps: Record<string, unknown> = {}
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      if (k !== 'source' && k !== 'file' && k !== 'code') componentProps[k] = v
    }
  }

  return (
    <div className="canvas-generated-wrap">
      <CanvasErrorBoundary key={retryKeyRef.current} onRetry={handleRetry} source={source}>
        <div className="canvas-generated-content">
          <Component {...componentProps} />
        </div>
      </CanvasErrorBoundary>
    </div>
  )
}

registerCanvas('generated', GeneratedRenderer)

export default GeneratedRenderer
