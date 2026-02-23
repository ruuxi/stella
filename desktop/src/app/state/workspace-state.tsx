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

export type WorkspaceState = {
  /** Active canvas content. null = show dashboard. */
  canvas: CanvasPayload | null
  /** Chat panel width in pixels */
  chatWidth: number
  /** Whether the chat panel is open */
  isChatOpen: boolean
}

type WorkspaceContextValue = {
  state: WorkspaceState
  /** Set workspace content to a canvas payload */
  openCanvas: (payload: CanvasPayload) => void
  /** Clear workspace canvas (returns to dashboard) */
  closeCanvas: () => void
  /** Update the chat panel width (called by resize handle) */
  setChatWidth: (width: number) => void
  /** Toggle the chat panel open/closed */
  setChatOpen: (open: boolean) => void
}

const DEFAULT_CHAT_WIDTH = 480
const MIN_CHAT_WIDTH = 320
const MAX_CHAT_WIDTH_RATIO = 0.5 // Never exceed 50% of viewport

const defaultState: WorkspaceState = {
  canvas: null,
  chatWidth: DEFAULT_CHAT_WIDTH,
  isChatOpen: true,
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export const WorkspaceProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<WorkspaceState>(defaultState)

  const openCanvas = useCallback((payload: CanvasPayload) => {
    setState((prev) => ({
      ...prev,
      canvas: payload,
    }))
  }, [])

  const closeCanvas = useCallback(() => {
    setState((prev) => ({
      ...prev,
      canvas: null,
    }))
  }, [])

  const setChatWidth = useCallback((width: number) => {
    const maxWidth = window.innerWidth * MAX_CHAT_WIDTH_RATIO
    const clamped = Math.max(MIN_CHAT_WIDTH, Math.min(width, maxWidth))
    setState((prev) => ({ ...prev, chatWidth: clamped }))
  }, [])

  const setChatOpen = useCallback((open: boolean) => {
    setState((prev) => ({ ...prev, isChatOpen: open }))
  }, [])

  const value = useMemo<WorkspaceContextValue>(
    () => ({ state, openCanvas, closeCanvas, setChatWidth, setChatOpen }),
    [state, openCanvas, closeCanvas, setChatWidth, setChatOpen],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useWorkspace = () => {
  const context = useContext(WorkspaceContext)
  if (!context) {
    throw new Error('useWorkspace must be used within WorkspaceProvider')
  }
  return context
}

export { MIN_CHAT_WIDTH, MAX_CHAT_WIDTH_RATIO, DEFAULT_CHAT_WIDTH }
