import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { UiMode, UiState, WindowMode } from '../../types/ui'
import { getElectronApi } from '../../services/electron'

type UiStateContextValue = {
  state: UiState
  setMode: (mode: UiMode) => void
  setConversationId: (id: string | null) => void
  setWindow: (windowMode: WindowMode) => void
  updateState: (partial: Partial<UiState>) => void
}

const defaultState: UiState = {
  mode: 'ask',
  window: 'full',
  conversationId: null,
}

const UiStateContext = createContext<UiStateContextValue | null>(null)

export const UiStateProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<UiState>(defaultState)

  useEffect(() => {
    const api = getElectronApi()
    if (!api) {
      return
    }

    api
      .getUiState()
      .then((nextState) => {
        setState(nextState)
      })
      .catch(() => {
        setState(defaultState)
      })

    const unsubscribe = api.onUiState((nextState) => {
      setState(nextState)
    })

    return () => {
      unsubscribe()
    }
  }, [])

  const updateState = (partial: Partial<UiState>) => {
    setState((prev) => ({ ...prev, ...partial }))
    const api = getElectronApi()
    if (api) {
      void api.setUiState(partial)
    }
  }

  const value = useMemo<UiStateContextValue>(() => {
    const setWindow = (windowMode: WindowMode) => {
      updateState({ window: windowMode })
      const api = getElectronApi()
      if (api) {
        api.showWindow(windowMode)
      }
    }

    return {
      state,
      setMode: (mode) => updateState({ mode }),
      setConversationId: (conversationId) => updateState({ conversationId }),
      setWindow,
      updateState,
    }
  }, [state, updateState])

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
