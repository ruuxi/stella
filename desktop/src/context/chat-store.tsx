import { createContext, useCallback, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  buildLocalHistoryMessages,
  type LocalHistoryMessage,
} from '@/app/chat/services/local-chat-store'
import { useAuthSessionState } from '@/global/auth/hooks/use-auth-session-state'

export type ChatStorageMode = 'cloud' | 'local'

type ChatStoreContextValue = {
  storageMode: ChatStorageMode
  isLocalStorage: boolean
  cloudFeaturesEnabled: boolean
  isAuthenticated: boolean
  buildHistory: (conversationId: string) => Promise<LocalHistoryMessage[] | undefined>
}

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null)

export const ChatStoreProvider = ({ children }: { children: ReactNode }) => {
  const { hasConnectedAccount } = useAuthSessionState()

  const cloudFeaturesEnabled = false
  const storageMode: ChatStorageMode = 'local'
  const isLocalStorage = true

  const buildHistory = useCallback(
    async (conversationId: string): Promise<LocalHistoryMessage[] | undefined> => {
      return await buildLocalHistoryMessages(conversationId)
    },
    [],
  )

  const value = useMemo<ChatStoreContextValue>(
    () => ({
      storageMode,
      isLocalStorage,
      cloudFeaturesEnabled,
      isAuthenticated: hasConnectedAccount,
      buildHistory,
    }),
    [
      storageMode,
      isLocalStorage,
      cloudFeaturesEnabled,
      hasConnectedAccount,
      buildHistory,
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
