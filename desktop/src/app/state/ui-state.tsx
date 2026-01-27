import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  UiMode,
  UiPanelState,
  UiState,
  UiStateUpdate,
  WindowMode,
} from '../../types/ui'
import { getElectronApi } from '../../services/electron'

type UiStateContextValue = {
  state: UiState
  setMode: (mode: UiMode) => void
  setConversationId: (id: string | null) => void
  setWindow: (windowMode: WindowMode) => void
  updateState: (partial: UiStateUpdate) => void
}

const defaultPanelState: UiPanelState = {
  isOpen: true,
  width: 420,
  focused: false,
  activeScreenId: 'media_viewer',
  chatDrawerOpen: false,
}

const defaultState: UiState = {
  mode: 'chat',
  window: 'full',
  conversationId: null,
  panel: { ...defaultPanelState },
}

const UiStateContext = createContext<UiStateContextValue | null>(null)

export const UiStateProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<UiState>(defaultState)

  const normalizeState = useCallback((incoming: Partial<UiState> | null | undefined): UiState => {
    const panel: UiPanelState = {
      ...defaultPanelState,
      ...(incoming?.panel ?? {}),
    }
    return {
      ...defaultState,
      ...(incoming ?? {}),
      panel,
    }
  }, [])

  useEffect(() => {
    const api = getElectronApi()
    if (!api) {
      return
    }

    api
      .getUiState()
      .then((nextState) => {
        setState(normalizeState(nextState))
      })
      .catch(() => {
        setState(defaultState)
      })

    const unsubscribe = api.onUiState((nextState) => {
      setState(normalizeState(nextState))
    })

    return () => {
      unsubscribe()
    }
  }, [normalizeState])

  const updateState = useCallback((partial: UiStateUpdate) => {
    let outbound: UiStateUpdate = partial
    setState((prev) => {
      const nextPanel = partial.panel ? { ...prev.panel, ...partial.panel } : prev.panel
      const next: UiState = {
        ...prev,
        ...partial,
        panel: nextPanel,
      }
      outbound = partial.panel ? { ...partial, panel: nextPanel } : partial
      return next
    })
    const api = getElectronApi()
    if (api) {
      void api.setUiState(outbound)
    }
  }, [])

  const setMode = useCallback(
    (mode: UiMode) => {
      updateState({ mode })
    },
    [updateState],
  )

  const setConversationId = useCallback(
    (conversationId: string | null) => {
      updateState({ conversationId })
    },
    [updateState],
  )

  const setWindow = useCallback(
    (windowMode: WindowMode) => {
      // Full view always uses chat mode
      if (windowMode === 'full') {
        updateState({ window: windowMode, mode: 'chat' })
      } else {
        updateState({ window: windowMode })
      }
      const api = getElectronApi()
      if (api) {
        api.showWindow(windowMode)
      }
    },
    [updateState],
  )

  const value = useMemo<UiStateContextValue>(
    () => ({
      state,
      setMode,
      setConversationId,
      setWindow,
      updateState,
    }),
    [state, setMode, setConversationId, setWindow, updateState],
  )

  return <UiStateContext.Provider value={value}>{children}</UiStateContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useUiState = () => {
  const context = useContext(UiStateContext)
  if (!context) {
    throw new Error('useUiState must be used within UiStateProvider')
  }
  return context
}
