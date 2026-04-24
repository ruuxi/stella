import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useAuthSessionState } from '@/global/auth/hooks/use-auth-session-state'

export type ChatStorageMode = 'cloud' | 'local'

type ChatStoreContextValue = {
  storageMode: ChatStorageMode
  isLocalStorage: boolean
  cloudFeaturesEnabled: boolean
  isAuthenticated: boolean
}

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null)

export const ChatStoreProvider = ({ children }: { children: ReactNode }) => {
  const { hasConnectedAccount } = useAuthSessionState()

  const cloudFeaturesEnabled = false
  const storageMode: ChatStorageMode = 'local'
  const isLocalStorage = true

  const value = useMemo<ChatStoreContextValue>(
    () => ({
      storageMode,
      isLocalStorage,
      cloudFeaturesEnabled,
      isAuthenticated: hasConnectedAccount,
    }),
    [
      storageMode,
      isLocalStorage,
      cloudFeaturesEnabled,
      hasConnectedAccount,
    ],
  )

  return <ChatStoreContext.Provider value={value}>{children}</ChatStoreContext.Provider>
}

export const useChatStore = () => {
  const context = useContext(ChatStoreContext)
  if (!context) {
    throw new Error('useChatStore must be used within ChatStoreProvider')
  }
  return context
}
