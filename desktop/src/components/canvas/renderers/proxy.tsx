import { registerCanvas } from '../canvas-registry'
import type { CanvasPayload } from '@/app/state/canvas-state'

const ProxyRenderer = ({ canvas }: { canvas: CanvasPayload }) => {
  if (!canvas.url) {
    return <div className="canvas-renderer-empty">No URL provided for proxy canvas</div>
  }

  return (
    <div className="canvas-proxy-wrap">
      <iframe
        className="canvas-proxy-frame"
        src={canvas.url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        title={canvas.title ?? 'Proxy'}
      />
    </div>
  )
}

registerCanvas('proxy', ProxyRenderer)

export default ProxyRenderer
