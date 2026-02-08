import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

// --- Types ---

export type CanvasPayload = {
  /** Name of the panel or app */
  name: string
  /** Display title for the panel header */
  title?: string
  /** Dev server URL for workspace apps (iframe). If absent, loads as panel via dynamic import. */
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

  const value = useMemo<CanvasContextValue>(
    () => ({ state, openCanvas, closeCanvas, setWidth }),
    [state, openCanvas, closeCanvas, setWidth],
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
