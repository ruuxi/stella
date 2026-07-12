import { useCallback, useEffect, useRef, useState } from 'react'
import { getPlatform } from '@/platform/electron/platform'
import { useChatStore } from '@/context/chat-store-context'
import { getOrCreateDeviceId } from '@/platform/electron/device-id'
import type { SendMessageArgs } from '../streaming/chat-types'
import type { MessageMetadata } from '@/features/chat/lib/event-transforms'
import type { EventRecord } from '@/features/chat/lib/event-transforms'
import type { MessageRecord } from '../../../../../runtime/contracts/local-chat.js'
import { resolveComposerContextState } from '../composer-context'
import { shouldTreatResumedAnswerAsStarted } from '@/features/chat/working-indicator-state'
import {
  buildAllLocalAttachments,
  toDisplayAttachments,
} from '../streaming/message-context'
import { toPastedTextDescriptor } from '../lib/paste-context'
import { useLocalAgentStream } from '../streaming/use-local-agent-stream'
import {
  combineQueuedSendPayloads,
  orderQueuedMessages,
  removeQueuedUserMessageById,
  restoreQueuedMessagesAfterFailedDrain,
  timestampQueuedOptimisticEventForDrain,
  type QueuedUserMessage,
} from './queued-user-messages'
import { useQueuedDequeueClock } from './use-queued-dequeue-clock'

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

type QueuedStreamPayload = {
  id: string
  queueOrder: number
  conversationId: string
  userPrompt: string
  selectedText: SendMessageArgs['selectedText']
  chatContext: SendMessageArgs['chatContext']
  deviceId: string
  platform?: string
  timezone?: string
  locale?: string
  messageMetadata?: SendMessageArgs['metadata']
  attachments: ReturnType<typeof buildAllLocalAttachments>
  optimisticEvent: EventRecord
}

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
  const queuedStreamPayloadsRef = useRef<QueuedStreamPayload[]>([])
  const drainingQueuedPayloadsRef = useRef<QueuedStreamPayload[]>([])
  const drainingQueuedMessageIdRef = useRef<string | null>(null)
  const queuedMessageOrderRef = useRef(0)
  const queueDrainPausedRef = useRef(false)
  const {
    isLocalStorage,
    storageMode,
  } = useChatStore()
  const issueDequeueTimestamp = useQueuedDequeueClock({
    conversationId: activeConversationId,
    persistedMessages,
    optimisticEvents,
  })

  const removeQueuedUserMessage = useCallback((messageId: string) => {
    queuedStreamPayloadsRef.current = queuedStreamPayloadsRef.current.filter(
      (message) => message.id !== messageId,
    )
    if (drainingQueuedMessageIdRef.current === messageId) {
      drainingQueuedMessageIdRef.current = null
      drainingQueuedPayloadsRef.current = []
    }
    queueDrainPausedRef.current = false
    setQueuedUserMessages((current) =>
      removeQueuedUserMessageById(current, messageId),
    )
  }, [])

  const handleRunStarted = useCallback((event: { userMessageId?: string }) => {
    const userMessageId = event.userMessageId
    if (!userMessageId) return
    queuedStreamPayloadsRef.current = queuedStreamPayloadsRef.current.filter(
      (message) => message.id !== userMessageId,
    )
    if (drainingQueuedMessageIdRef.current === userMessageId) {
      drainingQueuedMessageIdRef.current = null
      drainingQueuedPayloadsRef.current = []
    }
    setQueuedUserMessages((current) =>
      removeQueuedUserMessageById(current, userMessageId),
    )
  }, [])

  const handleRunFinished = useCallback(
    (event: {
      userMessageId?: string
      outcome: 'completed' | 'error' | 'canceled'
    }) => {
      if (
        event.userMessageId &&
        drainingQueuedMessageIdRef.current === event.userMessageId
      ) {
        drainingQueuedMessageIdRef.current = null
        drainingQueuedPayloadsRef.current = []
      }
      // A terminal outcome for the active run must not discard renderer-owned
      // follow-ups. If they have not been accepted yet, the idle-drain effect
      // will send them as the next turn. A drain that did start is removed by
      // `handleRunStarted`, so a later run error/cancel cannot replay it.
    },
    [],
  )

  const {
    taskDecorations,
    runtimeStatusText,
    markAssistantResponseTextStarted,
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
    cancelCurrentStream,
  } = useLocalAgentStream({
    activeConversationId,
    storageMode,
    onRunStarted: handleRunStarted,
    onRunFinished: handleRunFinished,
  })

  useEffect(() => {
    queuedStreamPayloadsRef.current = []
    drainingQueuedPayloadsRef.current = []
    drainingQueuedMessageIdRef.current = null
    queuedMessageOrderRef.current = 0
    queueDrainPausedRef.current = false
    setOptimisticEvents([])
    setQueuedUserMessages([])
    setPendingUserMessageId(null)
  }, [activeConversationId, setPendingUserMessageId])

  const clearOptimisticMessage = useCallback((messageId: string) => {
    setOptimisticEvents((current) =>
      current.filter((event) => event._id !== messageId),
    )
    setPendingUserMessageId((current) =>
      current === messageId ? null : current,
    )
  }, [setPendingUserMessageId])

  const drainQueuedMessagesIfIdle = useCallback(() => {
    if (isStreaming || !activeConversationId) return
    if (drainingQueuedMessageIdRef.current) return
    if (queueDrainPausedRef.current) return
    // Flush the ENTIRE queue in one drain: every message still waiting when
    // the app goes idle is combined (in queue order) into a single turn so
    // the assistant answers them together instead of running one full
    // response turn per queued message. A lone queued message passes through
    // `combineQueuedSendPayloads` untouched.
    const drainable = orderQueuedMessages(
      queuedStreamPayloadsRef.current.filter(
        (message) => message.conversationId === activeConversationId,
      ),
    )
    const combined = combineQueuedSendPayloads(drainable)
    if (!combined) return

    const drainedIds = new Set(drainable.map((message) => message.id))
    drainingQueuedMessageIdRef.current = combined.id
    drainingQueuedPayloadsRef.current = drainable
    queuedStreamPayloadsRef.current = queuedStreamPayloadsRef.current.filter(
      (message) => !drainedIds.has(message.id),
    )
    setQueuedUserMessages((current) =>
      current.filter((message) => !drainedIds.has(message.id)),
    )
    const dequeuedAtMs = issueDequeueTimestamp()
    const optimisticEventTemplate =
      drainable.length === 1
        ? combined.optimisticEvent
        : buildOptimisticUserEvent({
            id: combined.id,
            text:
              combined.userPrompt
              || combined.selectedText?.trim()
              || 'Attached context',
            timestamp: dequeuedAtMs,
            platform: combined.platform,
            timezone: combined.timezone,
            locale: combined.locale,
            ...(combined.messageMetadata
              ? { metadata: combined.messageMetadata }
              : {}),
            attachments: toDisplayAttachments(combined.attachments),
          })
    const optimisticEvent = timestampQueuedOptimisticEventForDrain(
      optimisticEventTemplate,
      dequeuedAtMs,
    )
    setOptimisticEvents((current) =>
      current.some((event) => event._id === combined.id)
        ? current
        : [...current, optimisticEvent],
    )
    setPendingUserMessageId(combined.id)

    startStream({
      userPrompt: combined.userPrompt,
      selectedText: combined.selectedText,
      chatContext: combined.chatContext,
      deviceId: combined.deviceId,
      platform: combined.platform,
      timezone: combined.timezone,
      locale: combined.locale,
      ...(combined.messageMetadata
        ? { messageMetadata: combined.messageMetadata }
        : {}),
      attachments: combined.attachments,
      userMessageEventId: combined.id,
      userMessageTimestamp: optimisticEvent.timestamp,
      onStartFailed: () => {
        if (drainingQueuedMessageIdRef.current === combined.id) {
          drainingQueuedMessageIdRef.current = null
        }
        const failedDrain = drainingQueuedPayloadsRef.current
        drainingQueuedPayloadsRef.current = []
        queueDrainPausedRef.current = true
        queuedStreamPayloadsRef.current = restoreQueuedMessagesAfterFailedDrain(
          queuedStreamPayloadsRef.current,
          failedDrain,
        )
        clearOptimisticMessage(combined.id)
        setQueuedUserMessages((current) =>
          restoreQueuedMessagesAfterFailedDrain(
            current,
            failedDrain.map((message) => {
              const payload = message.optimisticEvent.payload as
                | { text?: unknown }
                | undefined
              return {
                id: message.id,
                text:
                  (typeof payload?.text === 'string' ? payload.text : '')
                  || message.userPrompt
                  || 'Attached context',
                timestamp: message.optimisticEvent.timestamp,
                queueOrder: message.queueOrder,
              }
            }),
          ),
        )
      },
    })
  }, [
    activeConversationId,
    clearOptimisticMessage,
    isStreaming,
    issueDequeueTimestamp,
    setPendingUserMessageId,
    startStream,
  ])

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

  // Resume hand-off: an already-streamed answer can come back from persistence
  // with no live overlay. Mark it as response text so the inline working
  // indicator does not hang under the visible answer until the run terminates.
  useEffect(() => {
    if (!pendingUserMessageId) return
    const activeTurnAnswerVisible = persistedMessages.some((message) => {
      if (message.type !== 'assistant_message') return false
      if (!message.payload || typeof message.payload !== 'object') return false
      const payload = message.payload as { userMessageId?: string; text?: string }
      if (payload.userMessageId !== pendingUserMessageId) return false
      return typeof payload.text === 'string' && payload.text.trim().length > 0
    })
    if (
      shouldTreatResumedAnswerAsStarted({
        isStreaming,
        isStreamingResponseText,
        hasLiveStreamingOverlay: streamingAssistants.length > 0,
        activeTurnAnswerVisible,
      })
    ) {
      markAssistantResponseTextStarted()
    }
  }, [
    isStreaming,
    isStreamingResponseText,
    streamingAssistants,
    pendingUserMessageId,
    persistedMessages,
    markAssistantResponseTextStarted,
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
    const persistedIds = new Set(persistedMessages.map((message) => message._id))
    const queuedPayloads = queuedStreamPayloadsRef.current.filter(
      (message) => !persistedIds.has(message.id),
    )
    if (queuedPayloads.length !== queuedStreamPayloadsRef.current.length) {
      queuedStreamPayloadsRef.current = queuedPayloads
    }
    if (queuedUserMessages.length > 0) {
      setQueuedUserMessages((current) => {
        const next = current.filter((message) => !persistedIds.has(message.id))
        return next.length === current.length ? current : next
      })
    }
  }, [persistedMessages, queuedUserMessages.length])

  useEffect(() => {
    drainQueuedMessagesIfIdle()
  }, [drainQueuedMessagesIfIdle, queuedUserMessages.length])

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
      // `drainingQueuedMessageIdRef` covers the gap between a drain kicking
      // off `startStream` and `isStreaming` flipping true: a message
      // submitted inside that window must queue for the NEXT drain, not
      // start a competing turn mid-drain.
      const shouldQueueFollowUp =
        (isStreaming || drainingQueuedMessageIdRef.current !== null) &&
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
      const queueOrder = ++queuedMessageOrderRef.current
      const optimisticText =
        cleanedText || options.selectedText?.trim() || 'Attached context'

      const messageTimestamp = Date.now()
      // Resolve prerequisites before clearing the composer. A failed device
      // lookup must leave the user's draft intact rather than silently lose
      // a message that has not reached either queue or persistence.
      const deviceId = await getOrCreateDeviceId()
      options.onClear()
      await nextAnimationFrame()

      const optimisticEvent = buildOptimisticUserEvent({
        id: optimisticUserMessageId,
        text: optimisticText,
        timestamp: messageTimestamp,
        platform,
        timezone,
        locale: requestLocale,
        ...(messageMetadata ? { metadata: messageMetadata } : {}),
        attachments: toDisplayAttachments(attachments),
      })

      if (mode !== 'follow_up') {
        setOptimisticEvents((current) => [
          ...current,
          optimisticEvent,
        ])
        setPendingUserMessageId(optimisticUserMessageId)
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
        queueDrainPausedRef.current = false
        queuedStreamPayloadsRef.current = orderQueuedMessages([
          ...queuedStreamPayloadsRef.current,
          {
            id: optimisticUserMessageId,
            queueOrder,
            conversationId: resolvedConversationId,
            userPrompt: cleanedText,
            selectedText: options.selectedText,
            chatContext: options.chatContext,
            deviceId,
            platform,
            timezone,
            locale: requestLocale,
            ...(messageMetadata ? { messageMetadata } : {}),
            attachments,
            optimisticEvent,
          },
        ])
        setQueuedUserMessages((current) => orderQueuedMessages([
          ...current,
          {
            id: optimisticUserMessageId,
            text: optimisticText,
            timestamp: messageTimestamp,
            queueOrder,
          },
        ]))
        drainQueuedMessagesIfIdle()
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
        userMessageTimestamp: messageTimestamp,
        onStartFailed: () => {
          clearOptimisticMessage(optimisticUserMessageId)
        },
      })
    },
    [
      activeConversationId,
      drainQueuedMessagesIfIdle,
      isLocalStorage,
      isStreaming,
      notifyTierRestrictedModel,
      pendingUserMessageId,
      persistedMessages,
      startStream,
      locale,
      setPendingUserMessageId,
      clearOptimisticMessage,
    ],
  )

  return {
    taskDecorations,
    optimisticEvents,
    queuedUserMessages,
    runtimeStatusText,
    activeToolCallId,
    activeToolName,
    hasToolActivity,
    isToolActive,
    reasoningText,
    streamingAssistants,
    isStreaming,
    isStreamingResponseText,
    pendingUserMessageId,
    removeQueuedUserMessage,
    sendMessage,
    cancelCurrentStream,
  }
}
