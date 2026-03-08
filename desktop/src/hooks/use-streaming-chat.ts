import { useCallback, useEffect } from 'react'
import { getEventText } from '@/lib/event-transforms'
import { getPlatform } from '@/lib/platform'
import { useChatStore } from '@/providers/chat-store'
import { getOrCreateDeviceId } from '@/services/device'
import type { AttachmentRef, SendMessageArgs } from './streaming/chat-types'
import {
  buildCombinedPrompt,
  buildLocalScreenshotAttachments,
} from './streaming/message-context'
import {
  findQueuedFollowUp,
  toEventId,
} from './streaming/streaming-event-utils'
import { useLocalAgentStream } from './streaming/use-local-agent-stream'
import type { EventRecord } from './use-conversation-events'

export type { AgentStreamEvent, SelfModAppliedData } from './streaming/streaming-types'
export type { AttachmentRef, SendMessageArgs } from './streaming/chat-types'

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
    (event: {
      type: 'tool_request' | 'tool_result' | 'assistant_message'
      userMessageId?: string
      toolCallId?: string
      toolName?: string
      resultPreview?: string
      finalText?: string
    }) => {
      if (!activeConversationId) return

      chatStoreAppendAgentEvent({
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

  useEffect(() => {
    if (isStreaming || pendingUserMessageId || !activeConversationId) return

    const queued = findQueuedFollowUp<AttachmentRef>(events)
    if (!queued) return

    let cancelled = false

    void Promise.resolve().then(() => {
      if (cancelled) return

      const userPrompt = getEventText(queued.event)
      if (!userPrompt) return

      startStream({
        userMessageId: queued.event._id,
        userPrompt,
        attachments: queued.attachments,
      })
    })

    return () => {
      cancelled = true
    }
  }, [activeConversationId, events, isStreaming, pendingUserMessageId, startStream])

  const sendMessage = useCallback(
    async (options: SendMessageArgs) => {
      const resolvedConversationId = activeConversationId
      const { combinedText, hasScreenshotContext } = buildCombinedPrompt({
        text: options.text,
        selectedText: options.selectedText,
        chatContext: options.chatContext,
      })

      if (!resolvedConversationId || (!combinedText && !hasScreenshotContext)) {
        return
      }

      const deviceId = await getOrCreateDeviceId()
      const attachments = isLocalStorage && hasScreenshotContext
        ? buildLocalScreenshotAttachments(options.chatContext)
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
      const mode = isStreaming ? 'follow_up' : undefined

      const event = await chatStoreAppendEvent({
        conversationId: resolvedConversationId,
        type: 'user_message',
        deviceId,
        payload: {
          text: combinedText,
          attachments,
          platform,
          timezone,
          ...(mode && { mode }),
        },
      })

      const eventId = toEventId(event)
      if (!eventId) {
        return
      }

      if (mode === 'follow_up') {
        console.log(
          `[stella:trace] sendMessage (follow_up queued) | convId=${resolvedConversationId} | eventId=${eventId}`,
        )
        return
      }

      console.log(
        `[stella:trace] sendMessage | convId=${resolvedConversationId} | eventId=${eventId} | text=${combinedText.slice(0, 200)}`,
      )
      options.onClear()
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
      isLocalStorage,
      isStreaming,
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
