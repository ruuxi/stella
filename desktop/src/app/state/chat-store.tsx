/**
 * ChatStoreProvider — single source of truth for storageMode derivation
 * and unified chat storage operations. Consumers call chatStore methods
 * without knowing whether data goes to Convex or localStorage.
 */

import { createContext, useCallback, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useConvexAuth, useMutation, useAction } from 'convex/react'
import { useQuery } from 'convex/react'
import { api } from '../../convex/api'
import {
  appendLocalEvent,
  buildLocalHistoryMessages,
  type LocalHistoryMessage,
  type LocalAppendEventArgs,
} from '../../services/local-chat-store'
import {
  uploadScreenshotAttachments,
  type UploadedAttachment,
} from '../../hooks/streaming/attachment-upload'
import type { AppendedEventResponse } from '../../hooks/streaming/streaming-event-utils'

// --- Types ---

export type ChatStorageMode = 'cloud' | 'local'

type AppendEventArgs = Omit<LocalAppendEventArgs, 'timestamp' | 'eventId'>

type AppendAgentEventArgs = {
  conversationId: string
  type: 'tool_request' | 'tool_result' | 'assistant_message'
  userMessageId?: string
  toolCallId?: string
  toolName?: string
  resultPreview?: string
  finalText?: string
}

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

  appendEvent: (args: AppendEventArgs) => Promise<AppendedEventResponse | null>
  appendAgentEvent: (args: AppendAgentEventArgs) => void
  uploadAttachments: (args: UploadAttachmentsArgs) => Promise<UploadedAttachment[]>
  buildHistory: (conversationId: string, max?: number) => LocalHistoryMessage[] | undefined
  streamStrategy: 'local-only' | 'local-with-http-fallback'
}

// --- Context ---

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null)

// --- Provider ---

export const ChatStoreProvider = ({ children }: { children: ReactNode }) => {
  const { isAuthenticated } = useConvexAuth()

  const accountMode = useQuery(
    api.data.preferences.getAccountMode,
    isAuthenticated ? {} : 'skip',
  ) as 'private_local' | 'connected' | undefined

  const syncMode = useQuery(
    api.data.preferences.getSyncMode,
    isAuthenticated && accountMode === 'connected' ? {} : 'skip',
  ) as 'on' | 'off' | undefined

  const cloudFeaturesEnabled = isAuthenticated && accountMode === 'connected'
  const cloudStorageEnabled = cloudFeaturesEnabled && (syncMode ?? 'on') !== 'off'
  const storageMode: ChatStorageMode = cloudStorageEnabled ? 'cloud' : 'local'
  const isLocalStorage = storageMode === 'local'

  // Convex hooks called unconditionally (Rules of Hooks)
  const baseMutation = useMutation(api.events.appendEvent)
  const convexAppendEvent = useMemo(
    () => baseMutation.withOptimisticUpdate(
      (localStore, args) => {
        if (args.type !== 'user_message') return

        const queryArgs = {
          conversationId: args.conversationId,
          paginationOpts: { cursor: null, numItems: 200 },
        }
        const current = localStore.getQuery(api.events.listEvents, queryArgs)
        if (!current?.page) return

        const optimisticEvent = {
          _id: `optimistic-${crypto.randomUUID()}`,
          timestamp: (current.page[0]?.timestamp ?? 0) + 1,
          type: args.type,
          deviceId: args.deviceId,
          payload: args.payload,
        }

        localStore.setQuery(api.events.listEvents, queryArgs, {
          ...current,
          page: [optimisticEvent, ...current.page],
        })
      },
    ),
    [baseMutation],
  )

  const createAttachmentAction = useAction(api.data.attachments.createFromDataUrl)

  // --- Unified callbacks ---

  const appendEvent = useCallback(
    async (args: AppendEventArgs): Promise<AppendedEventResponse | null> => {
      if (isLocalStorage) {
        const localEvent = appendLocalEvent(args)
        return { _id: localEvent._id }
      }

      const event = await convexAppendEvent({
        conversationId: args.conversationId as never,
        type: args.type,
        deviceId: args.deviceId,
        requestId: args.requestId,
        targetDeviceId: args.targetDeviceId,
        payload: args.payload,
      })
      return event as AppendedEventResponse | null
    },
    [convexAppendEvent, isLocalStorage],
  )

  const appendAgentEvent = useCallback(
    (args: AppendAgentEventArgs) => {
      if (!isLocalStorage) return

      if (args.type === 'assistant_message') {
        appendLocalEvent({
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
        appendLocalEvent({
          conversationId: args.conversationId,
          type: 'tool_request',
          requestId: args.toolCallId,
          payload: {
            toolName: args.toolName,
          },
        })
        return
      }

      appendLocalEvent({
        conversationId: args.conversationId,
        type: 'tool_result',
        requestId: args.toolCallId,
        payload: {
          toolName: args.toolName,
          result: args.resultPreview,
        },
      })
    },
    [isLocalStorage],
  )

  const uploadAttachments = useCallback(
    async (args: UploadAttachmentsArgs): Promise<UploadedAttachment[]> => {
      if (isLocalStorage) return []

      return uploadScreenshotAttachments({
        screenshots: args.screenshots,
        conversationId: args.conversationId,
        deviceId: args.deviceId,
        createAttachment: async (createArgs) => {
          const attachment = await createAttachmentAction({
            conversationId: createArgs.conversationId as never,
            deviceId: createArgs.deviceId,
            dataUrl: createArgs.dataUrl,
          })
          return attachment as { _id?: string; storageKey?: string; url?: string | null; mimeType?: string; size?: number } | null
        },
      })
    },
    [createAttachmentAction, isLocalStorage],
  )

  const buildHistory = useCallback(
    (conversationId: string, max?: number): LocalHistoryMessage[] | undefined => {
      if (!isLocalStorage) return undefined
      return buildLocalHistoryMessages(conversationId, max ?? 50)
    },
    [isLocalStorage],
  )

  const streamStrategy: ChatStoreContextValue['streamStrategy'] = isLocalStorage ? 'local-only' : 'local-with-http-fallback'

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
      streamStrategy,
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
      streamStrategy,
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
