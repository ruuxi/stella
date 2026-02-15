import { useCallback, useRef, useState, useEffect, lazy, Suspense } from 'react'
import { useCanvas, type CanvasPayload } from '@/app/state/canvas-state'
import { Spinner } from '@/components/spinner'

const PanelRenderer = lazy(() => import('./renderers/panel'))
const AppframeRenderer = lazy(() => import('./renderers/appframe'))

const ANIM_DURATION = 350 // ms, matches CSS close duration

/** Extract port from a localhost URL, or null if not localhost. */
const getLocalhostPort = (url?: string): number | null => {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      const port = parseInt(parsed.port, 10)
      return Number.isFinite(port) ? port : null
    }
  } catch { /* ignore */ }
  return null
}

export const CanvasPanel = () => {
  const { state, closeCanvas, setWidth } = useCanvas()
  const { isOpen, canvas, width } = state
  const panelRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const lastCanvasRef = useRef<CanvasPayload | null>(null)
  const lastWidthRef = useRef(width)

  // Track the last valid canvas so we can render during close animation
  if (canvas) {
    lastCanvasRef.current = canvas
    lastWidthRef.current = width
  }

  // Open: mount then trigger visible for animation
  useEffect(() => {
    if (isOpen && canvas) {
      setClosing(false)
      // Delay one frame so the element mounts at its start state before animating
      const frame = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(frame)
    }
  }, [isOpen, canvas])

  // Close: play exit animation then unmount
  useEffect(() => {
    if (!isOpen && visible) {
      setClosing(true)
      const timer = setTimeout(() => {
        setVisible(false)
        setClosing(false)
      }, ANIM_DURATION)
      return () => clearTimeout(timer)
    }
  }, [isOpen, visible])

  const handleClose = useCallback(() => {
    const port = getLocalhostPort(canvas?.url ?? lastCanvasRef.current?.url)
    if (port) {
      window.electronAPI?.shellKillByPort(port)
    }
    closeCanvas()
  }, [canvas, closeCanvas])

  const widthRef = useRef(width)
  widthRef.current = width

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const startX = e.clientX
      const startWidth = widthRef.current
      setIsResizing(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const handleMouseMove = (e: MouseEvent) => {
        const totalDelta = e.clientX - startX
        setWidth(startWidth - totalDelta)
      }

      const handleMouseUp = () => {
        setIsResizing(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [setWidth],
  )

  // Only render when visible (open or animating out)
  if (!visible && !isOpen) return null

  const displayCanvas = canvas ?? lastCanvasRef.current
  const displayWidth = canvas ? width : lastWidthRef.current
  if (!displayCanvas) return null

  const animClass = (closing || (!isOpen && visible)) ? 'canvas-closing' : (visible && isOpen) ? 'canvas-open' : ''
  const shellClass = `canvas-panel-shell ${animClass}${isResizing ? ' canvas-resizing' : ''}`

  return (
    <div
      className={shellClass}
      style={{ '--canvas-panel-width': `${displayWidth}px` } as React.CSSProperties}
    >
      <div className={`canvas-resize-handle ${animClass}`} onMouseDown={handleMouseDown}>
        <div className="canvas-resize-bar" />
        <button
          className="canvas-panel-close"
          onClick={(e) => { e.stopPropagation(); handleClose() }}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="Close canvas"
          title={displayCanvas.title ?? displayCanvas.name}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>
      <div className="canvas-panel-viewport">
        <div
          ref={panelRef}
          className={`canvas-panel ${animClass}`}
        >
          <div className="canvas-panel-content">
            <Suspense fallback={<div className="canvas-vite-loading"><Spinner size="md" /></div>}>
              {displayCanvas.url
                ? <AppframeRenderer canvas={displayCanvas} />
                : <PanelRenderer canvas={displayCanvas} />
              }
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  )
}
