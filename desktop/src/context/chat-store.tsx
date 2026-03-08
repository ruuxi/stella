/**
 * ChatStoreProvider — single source of truth for storageMode derivation
 * and unified chat storage operations. Consumers call chatStore methods
 * without knowing whether data goes to Convex or localStorage.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { insertAtTop, useConvexAuth, useMutation, useAction } from 'convex/react'
import { api } from '@/convex/api'
import { useAccountMode } from '@/app/auth/hooks/use-account-mode'
import {
  appendLocalEvent,
  buildLocalHistoryMessages,
  type LocalHistoryMessage,
  type LocalAppendEventArgs,
} from '@/app/chat/services/local-chat-store'
import {
  uploadScreenshotAttachments,
  type UploadedAttachment,
} from '@/app/chat/streaming/attachment-upload'
import type { AppendedEventResponse } from '@/app/chat/streaming/streaming-event-utils'

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
  /** Controls event persistence: 'cloud' syncs to Convex, 'local' uses localStorage only. Orchestration is always local. */
  storageMode: ChatStorageMode
  isLocalStorage: boolean
  cloudFeaturesEnabled: boolean
  isAuthenticated: boolean

  appendEvent: (args: AppendEventArgs) => Promise<AppendedEventResponse | null>
  appendAgentEvent: (args: AppendAgentEventArgs) => void
  uploadAttachments: (args: UploadAttachmentsArgs) => Promise<UploadedAttachment[]>
  buildHistory: (conversationId: string) => Promise<LocalHistoryMessage[] | undefined>
}

// --- Context ---

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null)
const createOptimisticTimestamp = () => Date.now()

// --- Provider ---

export const ChatStoreProvider = ({ children }: { children: ReactNode }) => {
  const { isAuthenticated } = useConvexAuth()
  const accountMode = useAccountMode()

  // Read sync mode from local preferences (no Convex round-trip).
  // Re-reads on visibility change so settings changes take effect without reload.
  const [syncMode, setSyncMode] = useState<'on' | 'off'>('on')
  useEffect(() => {
    const read = () => {
      if (typeof window !== 'undefined' && window.electronAPI?.system.getLocalSyncMode) {
        void window.electronAPI.system.getLocalSyncMode().then((mode) => {
          setSyncMode(mode === 'off' ? 'off' : 'on')
        })
      }
    }
    read()
    const onVisibility = () => { if (!document.hidden) read() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const cloudFeaturesEnabled = isAuthenticated && accountMode === 'connected'
  const cloudStorageEnabled = cloudFeaturesEnabled && syncMode !== 'off'
  const storageMode: ChatStorageMode = cloudStorageEnabled ? 'cloud' : 'local'
  const isLocalStorage = storageMode === 'local'

  // Convex hooks called unconditionally (Rules of Hooks)
  const baseMutation = useMutation(api.events.appendEvent)
  const convexAppendEvent = useMemo(
    () => baseMutation.withOptimisticUpdate(
      (localStore, args) => {
        if (args.type !== 'user_message') return

        const optimisticEvent = {
          _id: `optimistic-${crypto.randomUUID()}`,
          timestamp: createOptimisticTimestamp(),
          type: args.type,
          deviceId: args.deviceId,
          payload: args.payload,
        }

        insertAtTop({
          paginatedQuery: api.events.listEvents,
          argsToMatch: { conversationId: args.conversationId },
          localQueryStore: localStore,
          item: optimisticEvent,
        })
      },
    ),
    [baseMutation],
  )

  const createAttachmentAction = useAction(api.data.attachments.createFromDataUrl)

  // --- Unified callbacks ---

  const appendEvent = useCallback(
    async (args: AppendEventArgs): Promise<AppendedEventResponse | null> => {
      // Always write to localStorage so the desktop runtime has local message
      // history available for both storage modes (thread store reads from here).
      const localEvent = await appendLocalEvent(args)

      if (isLocalStorage) {
        return { _id: localEvent._id }
      }

      try {
        const event = await convexAppendEvent({
          conversationId: args.conversationId,
          type: args.type,
          deviceId: args.deviceId,
          requestId: args.requestId,
          targetDeviceId: args.targetDeviceId,
          payload: args.payload,
        })
        return event as AppendedEventResponse | null
      } catch (error) {
        console.debug('[chat-store] cloud append failed, using local fallback:', (error as Error).message)
        return { _id: localEvent._id }
      }
    },
    [convexAppendEvent, isLocalStorage],
  )

  const appendAgentEvent = useCallback(
    (args: AppendAgentEventArgs) => {
      // Always write to localStorage for local message history availability.
      if (args.type === 'assistant_message') {
        void appendLocalEvent({
          conversationId: args.conversationId,
          type: 'assistant_message',
          requestId: args.userMessageId,
          payload: {
            text: args.finalText ?? '',
            ...(args.userMessageId ? { userMessageId: args.userMessageId } : {}),
          },
        }).catch(() => undefined)
        return
      }

      if (args.type === 'tool_request') {
        void appendLocalEvent({
          conversationId: args.conversationId,
          type: 'tool_request',
          requestId: args.toolCallId,
          payload: {
            toolName: args.toolName,
          },
        }).catch(() => undefined)
        return
      }

      void appendLocalEvent({
        conversationId: args.conversationId,
        type: 'tool_result',
        requestId: args.toolCallId,
        payload: {
          toolName: args.toolName,
          result: args.resultPreview,
        },
      }).catch(() => undefined)
    },
    [],
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
            conversationId: createArgs.conversationId,
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
    async (conversationId: string): Promise<LocalHistoryMessage[] | undefined> => {
      // Always build from local events — both modes write to localStorage
      // so the desktop runtime always has message history available.
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

