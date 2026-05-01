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
import { useLocale } from '@/shared/i18n'

type UseStreamingChatOptions = {
  conversationId: string | null
  events: EventRecord[]
}

export function useStreamingChat({
  conversationId,
  events,
}: UseStreamingChatOptions) {
  const activeConversationId = conversationId
  const locale = useLocale()
  const {
    isAuthenticated,
    isLocalStorage,
    storageMode,
  } = useChatStore()

  const {
    liveTasks,
    runtimeStatusText,
    streamingText,
    reasoningText,
    streamingResponseTarget,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    startStream,
    queueStream,
    cancelCurrentStream,
    resetStreamingState,
  } = useLocalAgentStream({
    activeConversationId,
    hasConnectedAccount: isAuthenticated,
    storageMode,
  })

  useEffect(() => {
    if (!pendingUserMessageId && !streamingResponseTarget) return

    const hasAssistantReply = events.some((event) => {
      if (event.type !== 'assistant_message') return false

      if (event.payload && typeof event.payload === 'object') {
        const payload = event.payload as {
          userMessageId?: string
          metadata?: {
            runtime?: {
              responseTarget?: typeof streamingResponseTarget
            }
          }
        }
        const responseTarget = payload.metadata?.runtime?.responseTarget
        if (
          !isStreaming &&
          streamingResponseTarget &&
          responseTarget &&
          (responseTarget.type === 'agent_turn' ||
            responseTarget.type === 'agent_terminal_notice') &&
          (streamingResponseTarget.type === 'agent_turn' ||
            streamingResponseTarget.type === 'agent_terminal_notice') &&
          responseTarget.agentId === streamingResponseTarget.agentId
        ) {
          return true
        }
        return (
          pendingUserMessageId !== null &&
          payload.userMessageId === pendingUserMessageId
        )
      }

      return false
    })

    if (hasAssistantReply) {
      resetStreamingState()
    }
  }, [
    events,
    isStreaming,
    pendingUserMessageId,
    resetStreamingState,
    streamingResponseTarget,
  ])

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
        : []

      const platform = getPlatform()
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const requestLocale = locale
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
          locale: requestLocale,
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
        locale: requestLocale,
        ...(options.metadata ? { messageMetadata: options.metadata } : {}),
        attachments,
      })
    },
    [
      activeConversationId,
      events,
      isLocalStorage,
      isStreaming,
      pendingUserMessageId,
      queueStream,
      startStream,
      locale,
    ],
  )

  return {
    liveTasks,
    runtimeStatusText,
    streamingText,
    reasoningText,
    streamingResponseTarget,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    sendMessage,
    cancelCurrentStream,
    resetStreamingState,
  }
}
