import { createContext, useCallback, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  buildLocalHistoryMessages,
  type LocalHistoryMessage,
} from '@/app/chat/services/local-chat-store'
import { useAuthSessionState } from '@/global/auth/hooks/use-auth-session-state'
import type { UploadedAttachment } from '@/app/chat/streaming/attachment-upload'

export type ChatStorageMode = 'cloud' | 'local'

type UploadAttachmentsArgs = {
  screenshots: { dataUrl: string }[] | undefined
  conversationId: string
  deviceId: string
}

type ChatStoreContextValue = {
  storageMode: ChatStorageMode
  isLocalStorage: boolean
  cloudFeaturesEnabled: boolean
  isAuthenticated: boolean
  uploadAttachments: (args: UploadAttachmentsArgs) => Promise<UploadedAttachment[]>
  buildHistory: (conversationId: string) => Promise<LocalHistoryMessage[] | undefined>
}

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null)

export const ChatStoreProvider = ({ children }: { children: ReactNode }) => {
  const { hasConnectedAccount } = useAuthSessionState()

  const cloudFeaturesEnabled = false
  const storageMode: ChatStorageMode = 'local'
  const isLocalStorage = true

  const uploadAttachments = useCallback(
    async (_args: UploadAttachmentsArgs): Promise<UploadedAttachment[]> => [],
    [],
  )

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
      uploadAttachments,
      buildHistory,
    }),
    [
      storageMode,
      isLocalStorage,
      cloudFeaturesEnabled,
      hasConnectedAccount,
      uploadAttachments,
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

export const useOptionalChatStore = () => useContext(ChatStoreContext)
