import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

// --- Types ---

/** Canvas tiers: data (charts/tables), proxy (facade over external API), app (sandboxed mini-app) */
export type CanvasTier = 'data' | 'proxy' | 'app'

export type CanvasPayload = {
  /** Identifies the canvas component to render (e.g. 'spreadsheet', 'chart', 'comfyui-proxy') */
  component: string
  /** Display title for the panel header */
  title?: string
  /** Which tier this canvas belongs to */
  tier: CanvasTier
  /** Structured data passed to the canvas component */
  data?: unknown
  /** URL for app-tier canvases (iframe src) */
  url?: string
}

export type CanvasState = {
  isOpen: boolean
  canvas: CanvasPayload | null
  /** Panel width as a CSS value (persisted across open/close within session) */
  width: number
}

type CanvasContextValue = {
  state: CanvasState
  /** Open the canvas panel with a payload */
  openCanvas: (payload: CanvasPayload) => void
  /** Close the canvas panel (preserves last payload for re-open) */
  closeCanvas: () => void
  /** Update the panel width (called by resize handle) */
  setWidth: (width: number) => void
  /** Replace just the data in the current canvas without closing/reopening */
  updateCanvasData: (data: unknown) => void
}

const DEFAULT_WIDTH = 480
const MIN_WIDTH = 320
const MAX_WIDTH_RATIO = 0.6 // Never exceed 60% of viewport

const defaultState: CanvasState = {
  isOpen: false,
  canvas: null,
  width: DEFAULT_WIDTH,
}

const CanvasContext = createContext<CanvasContextValue | null>(null)

export const CanvasProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<CanvasState>(defaultState)

  const openCanvas = useCallback((payload: CanvasPayload) => {
    setState((prev) => ({
      ...prev,
      isOpen: true,
      canvas: payload,
    }))
  }, [])

  const closeCanvas = useCallback(() => {
    setState((prev) => ({
      ...prev,
      isOpen: false,
    }))
  }, [])

  const setWidth = useCallback((width: number) => {
    const maxWidth = window.innerWidth * MAX_WIDTH_RATIO
    const clamped = Math.max(MIN_WIDTH, Math.min(width, maxWidth))
    setState((prev) => ({ ...prev, width: clamped }))
  }, [])

  const updateCanvasData = useCallback((data: unknown) => {
    setState((prev) => {
      if (!prev.canvas) return prev
      return {
        ...prev,
        canvas: { ...prev.canvas, data },
      }
    })
  }, [])

  const value = useMemo<CanvasContextValue>(
    () => ({ state, openCanvas, closeCanvas, setWidth, updateCanvasData }),
    [state, openCanvas, closeCanvas, setWidth, updateCanvasData],
  )

  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useCanvas = () => {
  const context = useContext(CanvasContext)
  if (!context) {
    throw new Error('useCanvas must be used within CanvasProvider')
  }
  return context
}

export { MIN_WIDTH, MAX_WIDTH_RATIO, DEFAULT_WIDTH }
