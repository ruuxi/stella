import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { useAuthSessionState } from '@/global/auth/hooks/use-auth-session-state'
import {
  ChatStoreContextProvider,
  LocalChatStoreProvider,
  useChatStore,
  type ChatStorageMode,
  type ChatStoreContextValue,
} from './chat-store-context'

export { LocalChatStoreProvider, useChatStore }

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

  return (
    <ChatStoreContextProvider value={value}>
      {children}
    </ChatStoreContextProvider>
  )
}
