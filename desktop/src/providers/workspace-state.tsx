import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type WorkspacePanel = {
  /** Stable panel identifier used by the workspace router. */
  name: string
  /** Optional display title shown in the shell header. */
  title?: string
  /** Optional source URL for localhost/dev-server backed panels. */
  url?: string
}

export type WorkspaceState = {
  /** Active workspace panel. null = show the home dashboard. */
  activePanel: WorkspacePanel | null
  /** Compatibility alias for legacy canvas-driven consumers. */
  canvas: WorkspacePanel | null
  /** Chat panel width in pixels */
  chatWidth: number
  /** Whether the chat panel is open */
  isChatOpen: boolean
}

type WorkspaceContextValue = {
  state: WorkspaceState
  /** Show a workspace panel in the center area. */
  openPanel: (panel: WorkspacePanel) => void
  /** Clear the active panel and return to the home dashboard. */
  closePanel: () => void
  /** Compatibility alias for legacy canvas-driven consumers. */
  openCanvas: (panel: WorkspacePanel) => void
  /** Compatibility alias for legacy canvas-driven consumers. */
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
  activePanel: null,
  canvas: null,
  chatWidth: DEFAULT_CHAT_WIDTH,
  isChatOpen: true,
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export const WorkspaceProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<WorkspaceState>(defaultState)

  const openPanel = useCallback((panel: WorkspacePanel) => {
    setState((prev) => ({
      ...prev,
      activePanel: panel,
      canvas: panel,
    }))
  }, [])

  const closePanel = useCallback(() => {
    setState((prev) => ({
      ...prev,
      activePanel: null,
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
    () => ({
      state,
      openPanel,
      closePanel,
      openCanvas: openPanel,
      closeCanvas: closePanel,
      setChatWidth,
      setChatOpen,
    }),
    [state, openPanel, closePanel, setChatWidth, setChatOpen],
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
