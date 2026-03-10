import { createContext, useCallback, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useConvexAuth } from 'convex/react'
import {
  appendLocalEvent,
  buildLocalHistoryMessages,
  type LocalHistoryMessage,
  type LocalAppendEventArgs,
} from '@/app/chat/services/local-chat-store'
import type { UploadedAttachment } from '@/app/chat/streaming/attachment-upload'
import type { AppendedEventResponse } from '@/app/chat/streaming/streaming-event-utils'

export type ChatStorageMode = 'cloud' | 'local'

type AppendEventArgs = Omit<LocalAppendEventArgs, 'timestamp' | 'eventId'>

type AppendAgentEventArgs = {
  conversationId: string
  type: 'tool_request' | 'tool_result' | 'assistant_message'
  agentType?: string
  userMessageId?: string
  toolCallId?: string
  toolName?: string
  args?: Record<string, unknown>
  resultPreview?: string
  html?: string
  finalText?: string
}

type UploadAttachmentsArgs = {
  screenshots: { dataUrl: string }[] | undefined
  conversationId: string
  deviceId: string
}

type ChatStoreContextValue = {
  /** Desktop transcript persistence is local-only. */
  storageMode: ChatStorageMode
  isLocalStorage: boolean
  cloudFeaturesEnabled: boolean
  isAuthenticated: boolean
  appendEvent: (args: AppendEventArgs) => Promise<AppendedEventResponse | null>
  appendAgentEvent: (args: AppendAgentEventArgs) => Promise<void>
  uploadAttachments: (args: UploadAttachmentsArgs) => Promise<UploadedAttachment[]>
  buildHistory: (conversationId: string) => Promise<LocalHistoryMessage[] | undefined>
}

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null)

export const ChatStoreProvider = ({ children }: { children: ReactNode }) => {
  const { isAuthenticated } = useConvexAuth()

  const cloudFeaturesEnabled = false
  const storageMode: ChatStorageMode = 'local'
  const isLocalStorage = true

  const appendEvent = useCallback(
    async (args: AppendEventArgs): Promise<AppendedEventResponse | null> => {
      const localEvent = await appendLocalEvent(args)
      return { _id: localEvent._id }
    },
    [],
  )

  const appendAgentEvent = useCallback(
    async (args: AppendAgentEventArgs) => {
      if (args.type === 'assistant_message') {
        await appendLocalEvent({
          conversationId: args.conversationId,
          type: 'assistant_message',
          requestId: args.userMessageId,
          payload: {
            text: args.finalText ?? '',
            ...(args.userMessageId ? { userMessageId: args.userMessageId } : {}),
          },
        })
        return
      }

      if (args.type === 'tool_request') {
        await appendLocalEvent({
          conversationId: args.conversationId,
          type: 'tool_request',
          requestId: args.toolCallId,
          payload: {
            toolName: args.toolName,
            ...(args.args ? { args: args.args } : {}),
            ...(args.agentType ? { agentType: args.agentType } : {}),
          },
        })
        return
      }

      await appendLocalEvent({
        conversationId: args.conversationId,
        type: 'tool_result',
        requestId: args.toolCallId,
        payload: {
          toolName: args.toolName,
          result: args.html ?? args.resultPreview,
          ...(args.resultPreview ? { resultPreview: args.resultPreview } : {}),
          ...(args.html ? { html: args.html } : {}),
          ...(args.agentType ? { agentType: args.agentType } : {}),
        },
      })
    },
    [],
  )

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
      isAuthenticated,
      appendEvent,
      appendAgentEvent,
      uploadAttachments,
      buildHistory,
    }),
    [
      storageMode,
      isLocalStorage,
      cloudFeaturesEnabled,
      isAuthenticated,
      appendEvent,
      appendAgentEvent,
      uploadAttachments,
      buildHistory,
    ],
  )

  return <ChatStoreContext.Provider value={value}>{children}</ChatStoreContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useChatStore = () => {
  const context = useContext(ChatStoreContext)
  if (!context) {
    throw new Error('useChatStore must be used within ChatStoreProvider')
  }
  return context
}

// eslint-disable-next-line react-refresh/only-export-components
export const useOptionalChatStore = () => useContext(ChatStoreContext)
