import { useCallback, useEffect, useState } from 'react'
import { getPlatform } from '@/platform/electron/platform'
import { useChatStore } from '@/context/chat-store-context'
import { getOrCreateDeviceId } from '@/platform/electron/device-id'
import type { SendMessageArgs } from '../streaming/chat-types'
import type { MessageMetadata } from '@/features/chat/lib/event-transforms'
import type { EventRecord } from '@/features/chat/lib/event-transforms'
import type { MessageRecord } from '../../../../../runtime/contracts/local-chat.js'
import { resolveComposerContextState } from '../composer-context'
import {
  buildAllLocalAttachments,
  toDisplayAttachments,
} from '../streaming/message-context'
import { toPastedTextDescriptor } from '../lib/paste-context'
import { useLocalAgentStream } from '../streaming/use-local-agent-stream'
import {
  removeQueuedUserMessageById,
  shouldClearQueuedUserMessagesForRunOutcome,
  type QueuedUserMessage,
} from './queued-user-messages'

export type { QueuedUserMessage } from './queued-user-messages'

type UseStreamingChatOptions = {
  conversationId: string | null
  locale: string
  notifyTierRestrictedModel?: () => void | Promise<void>
  /**
   * SQLite-persisted message stream (no optimistic / scheduled overlay).
   * Used to detect (a) an assistant reply for the pending user message,
   * (b) optimistic events that have been persisted (can be dropped),
   * (c) queued user messages that have been persisted.
   *
   * Must be the un-overlaid source — passing in the merged display
   * stream would loop optimistic events through this hook into
   * displayMessages.
   */
  persistedMessages: MessageRecord[]
}

const createLocalMessageId = () =>
  `local-${crypto.randomUUID()}`

const nextAnimationFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })

const buildContextMessageMetadata = (
  chatContext: SendMessageArgs['chatContext'],
  base?: MessageMetadata,
): MessageMetadata | undefined => {
  const appSelectionLabel = chatContext?.appSelection?.label?.trim()
  const activityLabel = chatContext?.activity?.label?.trim()
  const pastedTexts = (chatContext?.pastedTexts ?? [])
    .map((text) => text?.trim() ?? '')
    .filter((text) => text.length > 0)
    .map(toPastedTextDescriptor)
  if (!appSelectionLabel && !activityLabel && pastedTexts.length === 0) {
    return base
  }

  return {
    ...(base ?? {}),
    context: {
      ...(base?.context ?? {}),
      ...(appSelectionLabel ? { appSelectionLabel } : {}),
      ...(activityLabel ? { activityLabel } : {}),
      ...(pastedTexts.length > 0 ? { pastedTexts } : {}),
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

export function useStreamingChatCore({
  conversationId,
  locale,
  notifyTierRestrictedModel,
  persistedMessages,
}: UseStreamingChatOptions) {
  const activeConversationId = conversationId
  const [optimisticEvents, setOptimisticEvents] = useState<EventRecord[]>([])
  const [queuedUserMessages, setQueuedUserMessages] = useState<
    QueuedUserMessage[]
  >([])
  const {
    isLocalStorage,
    storageMode,
  } = useChatStore()

  const handleRunStarted = useCallback((event: { userMessageId?: string }) => {
    const userMessageId = event.userMessageId
    if (!userMessageId) return
    setQueuedUserMessages((current) =>
      removeQueuedUserMessageById(current, userMessageId),
    )
  }, [])

  const handleRunFinished = useCallback(
    (event: { outcome: 'completed' | 'error' | 'canceled' }) => {
      if (!shouldClearQueuedUserMessagesForRunOutcome(event.outcome)) return
      setQueuedUserMessages([])
    },
    [],
  )

  const {
    liveTasks,
    runtimeStatusText,
    activeRunId,
    activeToolCallId,
    activeToolName,
    hasToolActivity,
    isToolActive,
    isStreamingResponseText,
    reasoningText,
    streamingAssistants,
    isStreaming,
    pendingUserMessageId,
    setPendingUserMessageId,
    startStream,
    queueStream,
    cancelCurrentStream,
  } = useLocalAgentStream({
    activeConversationId,
    storageMode,
    onRunStarted: handleRunStarted,
    onRunFinished: handleRunFinished,
  })

  useEffect(() => {
    setOptimisticEvents([])
    setQueuedUserMessages([])
    setPendingUserMessageId(null)
  }, [activeConversationId, setPendingUserMessageId])

  useEffect(() => {
    if (!pendingUserMessageId) return

    // Once the runtime is no longer streaming AND we've seen a
    // persisted assistant_message that targets the pending user
    // message, drop `pendingUserMessageId` so composer / scroll
    // gating logic stops treating the turn as in-flight. Do NOT wipe
    // `streamingAssistants` here: active live rows keep owning the
    // visible text and borrow SQLite metadata as it arrives. A
    // multi-message run (preamble + post-tool answer) persists each row
    // as its own SQLite write, often across two `localChat:updated`
    // snapshots; clearing on the first snapshot would still drop the
    // second row's live stream for one tick.
    if (isStreaming) return
    const hasAssistantReply = persistedMessages.some((message) => {
      if (message.type !== 'assistant_message') return false
      if (!message.payload || typeof message.payload !== 'object') return false
      const payload = message.payload as { userMessageId?: string }
      return payload.userMessageId === pendingUserMessageId
    })
    if (hasAssistantReply) {
      setPendingUserMessageId(null)
    }
  }, [
    isStreaming,
    pendingUserMessageId,
    persistedMessages,
    setPendingUserMessageId,
  ])

  useEffect(() => {
    if (optimisticEvents.length === 0) return
    const persistedIds = new Set(persistedMessages.map((message) => message._id))
    setOptimisticEvents((current) => {
      const next = current.filter((event) => !persistedIds.has(event._id))
      return next.length === current.length ? current : next
    })
  }, [optimisticEvents.length, persistedMessages])

  useEffect(() => {
    if (queuedUserMessages.length === 0) return
    const persistedIds = new Set(persistedMessages.map((message) => message._id))
    setQueuedUserMessages((current) => {
      const next = current.filter((message) => !persistedIds.has(message.id))
      return next.length === current.length ? current : next
    })
  }, [persistedMessages, queuedUserMessages.length])

  const clearOptimisticMessage = useCallback((messageId: string) => {
    setOptimisticEvents((current) =>
      current.filter((event) => event._id !== messageId),
    )
    setPendingUserMessageId((current) =>
      current === messageId ? null : current,
    )
  }, [setPendingUserMessageId])

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
          !persistedMessages.some((message) => {
            if (message.type !== 'assistant_message') return false
            if (!message.payload || typeof message.payload !== 'object') return false
            return (
              (message.payload as { userMessageId?: string }).userMessageId
              === pendingUserMessageId
            )
          }))
      const mode = shouldQueueFollowUp ? 'follow_up' : undefined
      const optimisticUserMessageId = createLocalMessageId()
      const optimisticText =
        cleanedText || options.selectedText?.trim() || 'Attached context'

      const messageTimestamp = Date.now()
      options.onClear()
      await nextAnimationFrame()

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
            attachments: toDisplayAttachments(attachments),
            ...(mode ? { mode } : {}),
          }),
        ])
        setPendingUserMessageId(optimisticUserMessageId)
      }

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
      void notifyTierRestrictedModel?.()

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
      isLocalStorage,
      isStreaming,
      notifyTierRestrictedModel,
      pendingUserMessageId,
      persistedMessages,
      queueStream,
      startStream,
      locale,
      setPendingUserMessageId,
      clearOptimisticMessage,
    ],
  )

  return {
    liveTasks,
    optimisticEvents,
    queuedUserMessages,
    runtimeStatusText,
    activeRunId,
    activeToolCallId,
    activeToolName,
    hasToolActivity,
    isToolActive,
    reasoningText,
    streamingAssistants,
    isStreaming,
    isStreamingResponseText,
    pendingUserMessageId,
    sendMessage,
    cancelCurrentStream,
  }
}
