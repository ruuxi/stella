import { useCallback, useEffect } from 'react'
import { getPlatform } from '@/platform/electron/platform'
import { useChatStore } from '@/context/chat-store'
import { getOrCreateDeviceId } from '@/platform/electron/device'
import type { SendMessageArgs } from '../streaming/chat-types'
import type { EventRecord } from '@/app/chat/lib/event-transforms'
import { resolveComposerContextState } from '../composer-context'
import {
  buildAllLocalAttachments,
} from '../streaming/message-context'
import { useLocalAgentStream } from '../streaming/use-local-agent-stream'

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
    uploadAttachments: chatStoreUploadAttachments,
  } = useChatStore()

  const {
    liveTasks,
    runtimeStatusText,
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
      const cleanedText = options.text.trim()
      const contextState = resolveComposerContextState(
        options.chatContext,
        options.selectedText,
      )
      const hasAttachments = Boolean(
        options.chatContext?.regionScreenshots?.length
          || options.chatContext?.files?.length,
      )

      if (!resolvedConversationId || (!cleanedText && !contextState.hasSubmittableContext)) {
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
        (!pendingUserMessageId ||
          !events.some((event) => {
            if (event.type !== 'assistant_message') return false
            if (!event.payload || typeof event.payload !== 'object') return false
            return (
              (event.payload as { userMessageId?: string }).userMessageId
              === pendingUserMessageId
            )
          }))
      const mode = shouldQueueFollowUp ? 'follow_up' : undefined

      options.onClear()

      if (mode === 'follow_up') {
        console.log(
          `[stella:trace] sendMessage (follow_up queued) | convId=${resolvedConversationId}`,
        )
        queueStream({
          userPrompt: cleanedText,
          selectedText: options.selectedText,
          chatContext: options.chatContext,
          deviceId,
          platform,
          timezone,
          ...(mode ? { mode } : {}),
          ...(options.metadata ? { messageMetadata: options.metadata } : {}),
          attachments,
        })
        return
      }

      console.log(
        `[stella:trace] sendMessage | convId=${resolvedConversationId} | text=${cleanedText.slice(0, 200)}`,
      )
      startStream({
        userPrompt: cleanedText,
        selectedText: options.selectedText,
        chatContext: options.chatContext,
        deviceId,
        platform,
        timezone,
        ...(options.metadata ? { messageMetadata: options.metadata } : {}),
        attachments,
      })
    },
    [
      activeConversationId,
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
    liveTasks,
    runtimeStatusText,
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
