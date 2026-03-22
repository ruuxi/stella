import { useCallback, useEffect } from 'react'
import { getPlatform } from '@/platform/electron/platform'
import { useChatStore } from '@/context/chat-store'
import { getOrCreateDeviceId } from '@/platform/electron/device'
import type { SendMessageArgs } from '../streaming/chat-types'
import type { EventRecord } from '@/app/chat/lib/event-transforms'
import {
  buildAllLocalAttachments,
  buildCombinedPrompt,
} from '../streaming/message-context'
import { toEventId } from '../streaming/streaming-event-utils'
import { useLocalAgentStream, type LocalAgentEvent } from '../streaming/use-local-agent-stream'

type UseStreamingChatOptions = {
  conversationId: string | null
  events: EventRecord[]
}

export function useStreamingChat({
  conversationId,
  events,
}: UseStreamingChatOptions) {
  const activeConversationId = conversationId
  const {
    isLocalStorage,
    storageMode,
    appendAgentEvent: chatStoreAppendAgentEvent,
    appendEvent: chatStoreAppendEvent,
    uploadAttachments: chatStoreUploadAttachments,
  } = useChatStore()

  const appendLocalAgentEvent = useCallback(
    (event: LocalAgentEvent) => {
      if (!activeConversationId) return

      return chatStoreAppendAgentEvent({
        conversationId: activeConversationId,
        ...event,
      })
    },
    [activeConversationId, chatStoreAppendAgentEvent],
  )

  const {
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    startStream,
    queueStream,
    cancelCurrentStream,
    resetStreamingState,
  } = useLocalAgentStream({
    activeConversationId,
    storageMode,
    appendAgentEvent: appendLocalAgentEvent,
  })

  useEffect(() => {
    if (!pendingUserMessageId) return

    const hasAssistantReply = events.some((event) => {
      if (event.type !== 'assistant_message') return false

      if (event.payload && typeof event.payload === 'object') {
        return (
          (event.payload as { userMessageId?: string }).userMessageId
          === pendingUserMessageId
        )
      }

      return false
    })

    if (hasAssistantReply) {
      resetStreamingState()
    }
  }, [events, pendingUserMessageId, resetStreamingState])

  const sendMessage = useCallback(
    async (options: SendMessageArgs) => {
      const resolvedConversationId = activeConversationId
      const { combinedText, hasAttachments } = buildCombinedPrompt({
        text: options.text,
        selectedText: options.selectedText,
        chatContext: options.chatContext,
      })

      if (!resolvedConversationId || (!combinedText && !hasAttachments)) {
        return
      }

      const deviceId = await getOrCreateDeviceId()
      const attachments = isLocalStorage && hasAttachments
        ? buildAllLocalAttachments(options.chatContext)
        : await chatStoreUploadAttachments({
            screenshots: options.chatContext?.regionScreenshots,
            conversationId: resolvedConversationId,
            deviceId,
          }).then((uploaded) =>
            uploaded.map((attachment) => ({
              id: attachment.id,
              url: attachment.url,
              mimeType: attachment.mimeType,
            })),
          )

      const platform = getPlatform()
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const shouldQueueFollowUp =
        isStreaming &&
        Boolean(pendingUserMessageId) &&
        !events.some((event) => {
          if (event.type !== 'assistant_message') return false
          if (!event.payload || typeof event.payload !== 'object') return false
          return (
            (event.payload as { userMessageId?: string }).userMessageId
            === pendingUserMessageId
          )
        })
      const mode = shouldQueueFollowUp ? 'follow_up' : undefined

      const event = await chatStoreAppendEvent({
        conversationId: resolvedConversationId,
        type: 'user_message',
        deviceId,
        payload: {
          text: combinedText,
          attachments,
          platform,
          timezone,
          ...(options.metadata ? { metadata: options.metadata } : {}),
          ...(mode && { mode }),
        },
      })

      const eventId = toEventId(event)
      if (!eventId) {
        return
      }

      options.onClear()

      if (mode === 'follow_up') {
        console.log(
          `[stella:trace] sendMessage (follow_up queued) | convId=${resolvedConversationId} | eventId=${eventId}`,
        )
        queueStream({
          userMessageId: eventId,
          userPrompt: combinedText,
          attachments,
        })
        return
      }

      console.log(
        `[stella:trace] sendMessage | convId=${resolvedConversationId} | eventId=${eventId} | text=${combinedText.slice(0, 200)}`,
      )
      startStream({
        userMessageId: eventId,
        userPrompt: combinedText,
        attachments,
      })
    },
    [
      activeConversationId,
      chatStoreAppendEvent,
      chatStoreUploadAttachments,
      events,
      isLocalStorage,
      isStreaming,
      pendingUserMessageId,
      queueStream,
      startStream,
    ],
  )

  return {
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    sendMessage,
    cancelCurrentStream,
    resetStreamingState,
  }
}
