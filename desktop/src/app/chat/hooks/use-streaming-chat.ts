import { useCallback, useEffect, useRef, useState } from 'react'
import { getPlatform } from '@/platform/electron/platform'
import { useChatStore } from '@/context/chat-store'
import { getOrCreateDeviceId } from '@/platform/electron/device'
import type { SendMessageArgs } from '../streaming/chat-types'
import type { MessageMetadata } from '@/app/chat/lib/event-transforms'
import type { EventRecord } from '@/app/chat/lib/event-transforms'
import { resolveComposerContextState } from '../composer-context'
import {
  buildAllLocalAttachments,
} from '../streaming/message-context'
import { useLocalAgentStream } from '../streaming/use-local-agent-stream'
import { useLocale } from '@/shared/i18n'
import { useTierRestrictedModelToast } from './use-tier-restricted-model-toast'

type UseStreamingChatOptions = {
  conversationId: string | null
  events: EventRecord[]
}

export type QueuedUserMessage = {
  id: string
  text: string
  timestamp: number
}

const createLocalMessageId = () =>
  `local-${crypto.randomUUID()}`

const JUST_SENT_CLASS_MS = 900

const buildContextMessageMetadata = (
  chatContext: SendMessageArgs['chatContext'],
  base?: MessageMetadata,
): MessageMetadata | undefined => {
  const appSelectionLabel = chatContext?.appSelection?.label?.trim()
  if (!appSelectionLabel) return base

  return {
    ...(base ?? {}),
    context: {
      ...(base?.context ?? {}),
      appSelectionLabel,
    },
  }
}

const buildOptimisticUserEvent = (args: {
  id: string
  text: string
  timestamp: number
  platform?: string
  timezone?: string
  locale?: string
  metadata?: SendMessageArgs['metadata']
  attachments: ReturnType<typeof buildAllLocalAttachments>
  mode?: string
}): EventRecord => ({
  _id: args.id,
  type: 'user_message',
  timestamp: args.timestamp,
  payload: {
    text: args.text,
    ...(args.attachments.length ? { attachments: args.attachments } : {}),
    ...(args.platform ? { platform: args.platform } : {}),
    ...(args.timezone ? { timezone: args.timezone } : {}),
    ...(args.locale ? { locale: args.locale } : {}),
    ...(args.metadata ? { metadata: args.metadata } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
  },
})

export function useStreamingChat({
  conversationId,
  events,
}: UseStreamingChatOptions) {
  const activeConversationId = conversationId
  const [optimisticEvents, setOptimisticEvents] = useState<EventRecord[]>([])
  const [queuedUserMessages, setQueuedUserMessages] = useState<
    QueuedUserMessage[]
  >([])
  const [justSentUserMessageIds, setJustSentUserMessageIds] = useState<string[]>([])
  const justSentTimeoutsRef = useRef(new Map<string, number>())
  const locale = useLocale()
  const notifyTierRestrictedModel = useTierRestrictedModelToast()
  const {
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
    startStream,
    queueStream,
    cancelCurrentStream,
    resetStreamingState,
  } = useLocalAgentStream({
    activeConversationId,
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

  useEffect(() => {
    if (optimisticEvents.length === 0) return
    const persistedIds = new Set(events.map((event) => event._id))
    setOptimisticEvents((current) => {
      const next = current.filter((event) => !persistedIds.has(event._id))
      return next.length === current.length ? current : next
    })
  }, [events, optimisticEvents.length])

  useEffect(() => {
    if (queuedUserMessages.length === 0) return
    const persistedIds = new Set(events.map((event) => event._id))
    setQueuedUserMessages((current) => {
      const next = current.filter((message) => !persistedIds.has(message.id))
      return next.length === current.length ? current : next
    })
  }, [events, queuedUserMessages.length])

  useEffect(
    () => () => {
      for (const timeoutId of justSentTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId)
      }
      justSentTimeoutsRef.current.clear()
    },
    [],
  )

  const markJustSent = useCallback((messageId: string) => {
    setJustSentUserMessageIds((current) =>
      current.includes(messageId) ? current : [...current, messageId],
    )
    const existingTimeoutId = justSentTimeoutsRef.current.get(messageId)
    if (existingTimeoutId) {
      window.clearTimeout(existingTimeoutId)
    }
    const timeoutId = window.setTimeout(() => {
      justSentTimeoutsRef.current.delete(messageId)
      setJustSentUserMessageIds((current) =>
        current.filter((id) => id !== messageId),
      )
    }, JUST_SENT_CLASS_MS)
    justSentTimeoutsRef.current.set(messageId, timeoutId)
  }, [])

  const clearOptimisticMessage = useCallback((messageId: string) => {
    setOptimisticEvents((current) =>
      current.filter((event) => event._id !== messageId),
    )
    const timeoutId = justSentTimeoutsRef.current.get(messageId)
    if (timeoutId) {
      window.clearTimeout(timeoutId)
      justSentTimeoutsRef.current.delete(messageId)
    }
    setJustSentUserMessageIds((current) =>
      current.filter((id) => id !== messageId),
    )
  }, [])

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

      const attachments = isLocalStorage && hasAttachments
        ? buildAllLocalAttachments(options.chatContext)
        : []
      const messageMetadata = buildContextMessageMetadata(
        options.chatContext,
        options.metadata,
      )
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
      const optimisticUserMessageId = createLocalMessageId()
      const optimisticText =
        cleanedText || options.selectedText?.trim() || 'Attached context'

      const messageTimestamp = Date.now()
      if (mode === 'follow_up') {
        setQueuedUserMessages((current) => [
          ...current,
          {
            id: optimisticUserMessageId,
            text: optimisticText,
            timestamp: messageTimestamp,
          },
        ])
      } else {
        setOptimisticEvents((current) => [
          ...current,
          buildOptimisticUserEvent({
            id: optimisticUserMessageId,
            text: optimisticText,
            timestamp: messageTimestamp,
            platform,
            timezone,
            locale: requestLocale,
            ...(messageMetadata ? { metadata: messageMetadata } : {}),
            attachments,
            ...(mode ? { mode } : {}),
          }),
        ])
        markJustSent(optimisticUserMessageId)
      }
      options.onClear()

      let deviceId: string
      try {
        deviceId = await getOrCreateDeviceId()
      } catch (error) {
        clearOptimisticMessage(optimisticUserMessageId)
        setQueuedUserMessages((current) =>
          current.filter((message) => message.id !== optimisticUserMessageId),
        )
        throw error
      }

      // Fire-and-forget: surface a "model not available on your plan"
      // toast for restricted tiers (anonymous/free/go) when the user has a
      // saved non-default override for orchestrator/general. The backend
      // silently coerces to the tier-default model regardless. Deduped so
      // it doesn't spam on every send.
      void notifyTierRestrictedModel()

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
          ...(messageMetadata ? { messageMetadata } : {}),
          attachments,
          userMessageEventId: optimisticUserMessageId,
          onStartFailed: () => {
            setQueuedUserMessages((current) =>
              current.filter((message) => message.id !== optimisticUserMessageId),
            )
          },
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
        ...(messageMetadata ? { messageMetadata } : {}),
        attachments,
        userMessageEventId: optimisticUserMessageId,
        onStartFailed: () => {
          clearOptimisticMessage(optimisticUserMessageId)
        },
      })
    },
    [
      activeConversationId,
      events,
      isLocalStorage,
      isStreaming,
      notifyTierRestrictedModel,
      pendingUserMessageId,
      queueStream,
      startStream,
      locale,
      markJustSent,
      clearOptimisticMessage,
    ],
  )

  return {
    liveTasks,
    optimisticEvents,
    queuedUserMessages,
    justSentUserMessageIds,
    runtimeStatusText,
    streamingText,
    reasoningText,
    streamingResponseTarget,
    isStreaming,
    pendingUserMessageId,
    sendMessage,
    cancelCurrentStream,
    resetStreamingState,
  }
}
