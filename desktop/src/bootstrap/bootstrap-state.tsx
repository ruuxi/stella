import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

type RuntimeBootstrapStatus = 'preparing' | 'ready' | 'failed'

type BootstrapStateValue = {
  runtimeStatus: RuntimeBootstrapStatus
  runtimeError: string | null
  bootstrapAttempt: number
  markPreparing: () => void
  markReady: () => void
  markFailed: (message: string) => void
  retryRuntimeBootstrap: () => void
}

const BootstrapStateContext = createContext<BootstrapStateValue | null>(null)

export const BootstrapStateProvider = ({ children }: { children: ReactNode }) => {
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeBootstrapStatus>('preparing')
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0)

  const markPreparing = useCallback(() => {
    setRuntimeStatus('preparing')
    setRuntimeError(null)
  }, [])

  const markReady = useCallback(() => {
    setRuntimeStatus('ready')
    setRuntimeError(null)
  }, [])

  const markFailed = useCallback((message: string) => {
    setRuntimeStatus('failed')
    setRuntimeError(message)
  }, [])

  const retryRuntimeBootstrap = useCallback(() => {
    setRuntimeStatus('preparing')
    setRuntimeError(null)
    setBootstrapAttempt((attempt) => attempt + 1)
  }, [])

  const value = useMemo<BootstrapStateValue>(
    () => ({
      runtimeStatus,
      runtimeError,
      bootstrapAttempt,
      markPreparing,
      markReady,
      markFailed,
      retryRuntimeBootstrap,
    }),
    [
      runtimeStatus,
      runtimeError,
      bootstrapAttempt,
      markPreparing,
      markReady,
      markFailed,
      retryRuntimeBootstrap,
    ],
  )

  return (
    <BootstrapStateContext.Provider value={value}>
      {children}
    </BootstrapStateContext.Provider>
  )
}

export const useBootstrapState = () => {
  const context = useContext(BootstrapStateContext)
  if (!context) {
    throw new Error('useBootstrapState must be used within BootstrapStateProvider')
  }
  return context
}
