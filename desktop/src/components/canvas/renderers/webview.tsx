import { useRef, useCallback, useState } from 'react'
import { registerCanvas } from '../CanvasPanel'
import type { CanvasPayload } from '@/app/state/canvas-state'

const WebviewRenderer = ({ canvas }: { canvas: CanvasPayload }) => {
  const webviewRef = useRef<HTMLWebViewElement>(null)
  const [loading, setLoading] = useState(true)

  const handleReload = useCallback(() => {
    const wv = webviewRef.current as unknown as { reload?: () => void }
    wv?.reload?.()
  }, [])

  if (!canvas.url) {
    return <div className="canvas-renderer-empty">No URL provided for webview</div>
  }

  return (
    <div className="canvas-webview-wrap">
      <div className="canvas-webview-toolbar">
        <span className="canvas-webview-url">{canvas.url}</span>
        <button className="canvas-webview-reload" onClick={handleReload}>
          Reload
        </button>
      </div>
      {loading && (
        <div className="canvas-renderer-empty">Loading...</div>
      )}
      {/* @ts-expect-error webview is an Electron-specific tag */}
      <webview
        ref={webviewRef}
        className="canvas-webview-frame"
        src={canvas.url}
        style={{ display: loading ? 'none' : 'flex', flex: 1 }}
        // eslint-disable-next-line react/no-unknown-property
        allowpopups=""
        onDidFinishLoad={() => setLoading(false)}
        onDomReady={() => setLoading(false)}
      />
    </div>
  )
}

registerCanvas('webview', WebviewRenderer)

export default WebviewRenderer
