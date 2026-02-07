import { useCallback, useRef, type JSX } from 'react'
import { useCanvas, type CanvasPayload } from '@/app/state/canvas-state'
import { ResizeHandle } from '@/components/resize-handle'

// Register all canvas renderers (side-effect imports)
import './renderers/index'

/**
 * Registry of canvas components by their `component` key.
 * Skills/adaptors register here to provide their UI.
 */
type CanvasRenderer = (props: { canvas: CanvasPayload }) => JSX.Element | null

const canvasRegistry = new Map<string, CanvasRenderer>()

/** Register a canvas component for a given key */
export const registerCanvas = (key: string, renderer: CanvasRenderer) => {
  canvasRegistry.set(key, renderer)
}

/** Placeholder shown when no renderer is registered for a canvas type */
const CanvasPlaceholder = ({ canvas }: { canvas: CanvasPayload }) => (
  <div className="canvas-placeholder">
    <div className="canvas-placeholder-icon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M9 3v18" />
      </svg>
    </div>
    <div className="canvas-placeholder-title">
      {canvas.component}
    </div>
    <div className="canvas-placeholder-description">
      No renderer registered for this canvas type.
      <br />
      Tier: {canvas.tier}
    </div>
  </div>
)

export const CanvasPanel = () => {
  const { state, closeCanvas, setWidth } = useCanvas()
  const { isOpen, canvas, width } = state
  const panelRef = useRef<HTMLDivElement>(null)

  const handleResize = useCallback(
    (delta: number) => {
      // Dragging left (negative delta) should increase panel width
      setWidth(width - delta)
    },
    [width, setWidth],
  )

  if (!isOpen || !canvas) return null

  const Renderer = canvasRegistry.get(canvas.component)

  return (
    <>
      <ResizeHandle
        orientation="horizontal"
        onResize={handleResize}
        className="canvas-resize-handle"
      />
      <div
        ref={panelRef}
        className="canvas-panel"
        style={{ width }}
      >
        <div className="canvas-panel-header">
          <div className="canvas-panel-header-left">
            <span className="canvas-panel-tier">{canvas.tier}</span>
            <span className="canvas-panel-title">{canvas.title ?? canvas.component}</span>
          </div>
          <div className="canvas-panel-header-right">
            <button
              className="canvas-panel-close"
              onClick={closeCanvas}
              aria-label="Close canvas"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="canvas-panel-content">
          {Renderer ? <Renderer canvas={canvas} /> : <CanvasPlaceholder canvas={canvas} />}
        </div>
      </div>
    </>
  )
}
