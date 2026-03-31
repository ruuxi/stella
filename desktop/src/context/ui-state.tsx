import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { UiMode, UiState, ViewType, WindowMode } from '@/shared/contracts/ui'
import { getElectronApi } from '@/platform/electron/electron'

type UiStateContextValue = {
  state: UiState
  setMode: (mode: UiMode) => void
  setView: (view: ViewType) => void
  setConversationId: (id: string | null) => void
  setWindow: (windowMode: WindowMode) => void
  updateState: (partial: Partial<UiState>) => void
}

const defaultState: UiState = {
  mode: 'chat',
  window: 'full',
  view: 'app',
  conversationId: null,
  isVoiceRtcActive: false,
}

const UiStateContext = createContext<UiStateContextValue | null>(null)

export const UiStateProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<UiState>(defaultState)
  const hasHydratedFromMainRef = useRef(false)
  const pendingLocalStateRef = useRef<Partial<UiState>>({})

  const applyHydratedState = useCallback((nextState: UiState) => {
    if (hasHydratedFromMainRef.current) {
      return
    }

    hasHydratedFromMainRef.current = true
    const pendingLocalState = pendingLocalStateRef.current
    pendingLocalStateRef.current = {}
    setState({ ...nextState, ...pendingLocalState })
  }, [])

  useEffect(() => {
    const api = getElectronApi()
    if (!api) {
      return
    }

    void api.ui.getState().then(applyHydratedState).catch(() => {
      applyHydratedState(defaultState)
    })

    const unsubscribe = api.ui.onState((nextState) => {
      hasHydratedFromMainRef.current = true
      pendingLocalStateRef.current = {}
      setState({ ...nextState })
    })

    return () => {
      unsubscribe()
    }
  }, [applyHydratedState])

  const updateState = useCallback((partial: Partial<UiState>) => {
    setState((prev) => ({ ...prev, ...partial }))
    if (!hasHydratedFromMainRef.current) {
      pendingLocalStateRef.current = {
        ...pendingLocalStateRef.current,
        ...partial,
      }
    }
    const api = getElectronApi()
    if (api) {
      void api.ui.setState(partial)
    }
  }, [])

  const setMode = useCallback(
    (mode: UiMode) => {
      updateState({ mode })
    },
    [updateState],
  )

  const setView = useCallback(
    (view: ViewType) => {
      updateState({ view })
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
      updateState(
        windowMode === 'full'
          ? { window: windowMode, mode: 'chat' }
          : { window: windowMode },
      )
      getElectronApi()?.window.show(windowMode)
    },
    [updateState],
  )

  const value = useMemo<UiStateContextValue>(
    () => ({
      state,
      setMode,
      setView,
      setConversationId,
      setWindow,
      updateState,
    }),
    [state, setMode, setView, setConversationId, setWindow, updateState],
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
