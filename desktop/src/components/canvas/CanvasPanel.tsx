import { useCallback, useRef, lazy, Suspense } from 'react'
import { useCanvas } from '@/app/state/canvas-state'
import { ResizeHandle } from '@/components/resize-handle'
import { Spinner } from '@/components/spinner'

const PanelRenderer = lazy(() => import('./renderers/panel'))
const AppframeRenderer = lazy(() => import('./renderers/appframe'))

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
            <span className="canvas-panel-title">{canvas.title ?? canvas.name}</span>
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
          <Suspense fallback={<div className="canvas-vite-loading"><Spinner size="md" /></div>}>
            {canvas.url
              ? <AppframeRenderer canvas={canvas} />
              : <PanelRenderer canvas={canvas} />
            }
          </Suspense>
        </div>
      </div>
    </>
  )
}
