import { useState, useEffect, useCallback, useRef } from 'react'
import { registerCanvas } from '../CanvasPanel'
import { CanvasErrorBoundary } from '../CanvasErrorBoundary'
import { compile } from '../compiler/compile'
import { evaluate } from '../compiler/evaluate'
import { Spinner } from '@/components/spinner'
import type { CanvasPayload } from '@/app/state/canvas-state'

type GeneratedData = {
  source: string
  [key: string]: unknown
}

const GeneratedRenderer = ({ canvas }: { canvas: CanvasPayload }) => {
  const data = canvas.data as GeneratedData | undefined
  const source = data?.source ?? ''
  const [Component, setComponent] = useState<React.ComponentType<Record<string, unknown>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [compiling, setCompiling] = useState(false)
  const lastSourceRef = useRef<string>('')
  const retryKeyRef = useRef(0)

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

    const evalResult = evaluate(compileResult.code)

    if (evalResult.error) {
      setError(evalResult.error)
      setCompiling(false)
      return
    }

    setComponent(() => evalResult.component)
    setCompiling(false)
  }, [])

  // Compile on source change
  useEffect(() => {
    if (source === lastSourceRef.current) return
    lastSourceRef.current = source
    void doCompile(source)
  }, [source, doCompile])

  const handleRetry = useCallback(() => {
    retryKeyRef.current++
    lastSourceRef.current = ''
    void doCompile(source)
  }, [source, doCompile])

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

  // Pass extra data props (excluding source) to the generated component
  const componentProps: Record<string, unknown> = {}
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      if (k !== 'source') componentProps[k] = v
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
