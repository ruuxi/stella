import { useRef, useCallback, useState } from 'react'
import type { CanvasPayload } from '@/app/state/canvas-state'
import { sanitizeCanvasAppUrl } from '@/lib/url-safety'

const AppframeRenderer = ({ canvas }: { canvas: CanvasPayload }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const safeCanvasUrl = sanitizeCanvasAppUrl(canvas.url)

  const handleReload = useCallback(() => {
    if (!safeCanvasUrl) {
      return
    }
    setError(false)
    setLoading(true)
    if (iframeRef.current) {
      iframeRef.current.src = safeCanvasUrl
    }
  }, [safeCanvasUrl])

  if (!canvas.url) {
    return <div className="canvas-renderer-empty">No URL provided</div>
  }
  if (!safeCanvasUrl) {
    return <div className="canvas-renderer-empty">Blocked unsupported URL</div>
  }

  return (
    <div className="canvas-appframe-wrap">
      <div className="canvas-appframe-toolbar">
        <span className="canvas-appframe-url">{safeCanvasUrl}</span>
        <button className="canvas-appframe-reload" onClick={handleReload}>
          Reload
        </button>
      </div>
      {loading && !error && (
        <div className="canvas-renderer-empty">Loading...</div>
      )}
      {error && (
        <div className="canvas-renderer-empty">
          Failed to load. Is the dev server running?
          <button className="canvas-appframe-reload" onClick={handleReload} style={{ marginTop: 8 }}>
            Retry
          </button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        className="canvas-appframe-frame"
        src={safeCanvasUrl}
        style={{ display: loading || error ? 'none' : 'flex', flex: 1, border: 'none' }}
        onLoad={() => { setLoading(false); setError(false) }}
        onError={() => { setLoading(false); setError(true) }}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
      />
    </div>
  )
}

export default AppframeRenderer
