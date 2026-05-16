import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type {
  ChatColumnComposer,
  ChatColumnConversation,
  ChatColumnScroll,
} from '@/app/chat/chat-column-types'
import { deriveComposerState } from '@/app/chat/composer-context'
import { useConversationActivity } from '@/app/chat/hooks/use-conversation-activity'
import { useConversationFiles } from '@/app/chat/hooks/use-conversation-files'
import { useConversationMessages } from '@/app/chat/hooks/use-conversation-messages'
import { useScheduledEvents } from '@/app/chat/hooks/use-scheduled-events'
import { useStreamingChat } from '@/app/chat/hooks/use-streaming-chat'
import { useTaskProgressSummaries } from '@/app/chat/hooks/use-task-progress-summaries'
import { useTraceEventMonitor, useTraceIpcListener } from '@/debug/hooks/use-trace-listener'
import { type EventRecord } from '@/app/chat/lib/event-transforms'
import { groupEventsIntoMessages } from '@/app/chat/lib/group-events-into-messages'
import type { MessageRecord } from '../../../runtime/contracts/local-chat.js'
import { useCapturedChatContext } from './use-captured-chat-context'
import { useChatScrollManagement } from './use-chat-scroll-management'
import { useChatHomeSurface } from './use-chat-home-surface'
import { useAgentInputRouting } from './use-agent-input-routing'
import { useStellaSendMessageBridge } from './use-stella-send-message-bridge'
import { smoothScrollTo } from '@/shared/lib/smooth-scroll'

const SENT_MESSAGE_SCROLL_NUDGE_MS = 360
const SENT_MESSAGE_SCROLL_SETTLE_DELAY_MS = 80

/**
 * Cap on the scheduled-events overlay window. Scheduler-pending events
 * are rare (a handful per active cron / heartbeat) so a small cap keeps
 * the overlay cost negligible without truncating real workloads.
 */
const SCHEDULED_EVENTS_OVERLAY_MAX = 200

/**
 * Merge `MessageRecord` lists keyed by `_id` and sort by `(timestamp,
 * _id)`. First occurrence wins on duplicate ids — pass the authoritative
 * source first (e.g. SQLite-backed `persistedMessages`) so synthetic
 * overlay messages (scheduled / optimistic) defer to it once the runtime
 * persists them.
 */
const mergeMessageSources = (
  ...sources: MessageRecord[][]
): MessageRecord[] => {
  const seen = new Map<string, MessageRecord>()
  for (const source of sources) {
    for (const message of source) {
      if (!seen.has(message._id)) {
        seen.set(message._id, message)
      }
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    return a._id.localeCompare(b._id)
  })
}

type UseFullShellChatOptions = {
  activeConversationId: string | null
  /** True when the user is currently on the `/chat` route. */
  isOnChatRoute: boolean
  isDev: boolean
}

export function useFullShellChat({
  activeConversationId,
  isOnChatRoute,
  isDev,
}: UseFullShellChatOptions) {
  const [message, setMessage] = useState('')
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0)
  const { chatContext, setChatContext, selectedText, setSelectedText } =
    useCapturedChatContext()

  const {
    messages: persistedMessages,
    hasOlderMessages,
    isLoadingOlder: isLoadingOlderMessages,
    isInitialLoading: isInitialLoadingMessages,
    loadOlder: loadOlderMessages,
  } = useConversationMessages(activeConversationId ?? undefined)

  const {
    activities,
    latestMessageTimestampMs,
    hasOlderActivity,
    isLoadingOlder: isLoadingOlderActivity,
    loadOlder: loadOlderActivity,
  } = useConversationActivity(activeConversationId ?? undefined)

  const {
    files: persistedFiles,
    hasOlderFiles,
    isLoadingOlder: isLoadingOlderFiles,
    loadOlder: loadOlderFiles,
  } = useConversationFiles(activeConversationId ?? undefined)

  // Scheduler-pending user messages (cron / heartbeat) that haven't
  // been persisted to SQLite yet. Merged into the visible timeline as
  // an overlay; persisted copies in `persistedMessages` take precedence
  // once they land.
  const { events: scheduledEvents } = useScheduledEvents({
    conversationId: activeConversationId ?? undefined,
    enabled: Boolean(activeConversationId),
    maxItems: SCHEDULED_EVENTS_OVERLAY_MAX,
  })

  const {
    liveTasks,
    optimisticEvents,
    justSentUserMessageIds,
    runtimeStatusText,
    streamingText,
    reasoningText,
    streamingResponseTarget,
    isStreaming,
    pendingUserMessageId,
    queuedUserMessages,
    sendMessage,
    cancelCurrentStream,
  } = useStreamingChat({
    conversationId: activeConversationId,
    persistedMessages,
  })

  // Visible chat timeline source: SQLite-backed `persistedMessages`
  // (which already carry per-turn tool events) plus synthetic overlays
  // for the optimistic just-sent user message and any scheduler-pending
  // events. Both overlays drop off once the runtime persists their
  // backing rows — `persistedMessages` wins on dedupe.
  const overlayMessages = useMemo(() => {
    if (optimisticEvents.length === 0 && scheduledEvents.length === 0) {
      return [] as MessageRecord[]
    }
    const overlayEvents: EventRecord[] = []
    for (const event of optimisticEvents) overlayEvents.push(event)
    for (const event of scheduledEvents) {
      if (
        event.type !== 'user_message' &&
        event.type !== 'assistant_message'
      ) {
        continue
      }
      if (overlayEvents.some((other) => other._id === event._id)) continue
      overlayEvents.push(event)
    }
    return groupEventsIntoMessages(overlayEvents)
  }, [optimisticEvents, scheduledEvents])

  const displayMessages = useMemo(() => {
    if (overlayMessages.length === 0) return persistedMessages
    return mergeMessageSources(persistedMessages, overlayMessages)
  }, [overlayMessages, persistedMessages])

  const taskProgressSummaries = useTaskProgressSummaries({
    liveTasks,
    messages: persistedMessages,
    activities,
    latestMessageTimestampMs,
  })

  useTraceIpcListener(isDev)

  // Dev-only event trace consumes the union of activity + message + the
  // per-turn tool events. The hook's internal `seenIds` set keeps it
  // idempotent across re-runs, so we can rebuild the list cheaply on
  // every tick without double-firing trace entries.
  const traceEvents = useMemo<EventRecord[]>(() => {
    if (!isDev) return []
    const out: EventRecord[] = []
    for (const event of activities) out.push(event)
    for (const message of persistedMessages) {
      out.push(message)
      for (const toolEvent of message.toolEvents) out.push(toolEvent)
    }
    return out
  }, [activities, isDev, persistedMessages])
  useTraceEventMonitor(isDev, traceEvents)

  const hasMessages = displayMessages.length > 0

  const {
    showHomeContent,
    enterChatSurfaceForInteraction,
    resetIdleTimer,
    dismissHome,
    showHome,
  } = useChatHomeSurface({
    isOnChatRoute,
    hasMessages,
    isStreaming,
    activeConversationId,
  })

  const {
    sendContextlessMessage,
    sendAgentInputMessage,
    sendMessageWithContext,
  } = useAgentInputRouting({
    activeConversationId,
    sendMessage,
    enterChatSurfaceForInteraction,
  })

  useStellaSendMessageBridge({
    sendContextlessMessage,
    sendAgentInputMessage,
  })

  /**
   * Scroll: backed by Legend List (web entry). The list owns scrolling
   * and content geometry; the hook adapts list state into the surface
   * UI concerns (at-bottom, custom thumb, scroll-to-bottom button).
   */
  const {
    listRef,
    onListScroll,
    onStartReached,
    isAtBottom,
    isNearBottom,
    getIsNearBottom,
    showScrollButton,
    scrollToBottom,
    thumbState,
  } = useChatScrollManagement({
    hasOlderEvents: hasOlderMessages,
    isLoadingOlder: isLoadingOlderMessages,
    onLoadOlder: loadOlderMessages,
  })

  // On conversation change, snap to the latest content. `initialScrollAtEnd`
  // covers fresh mounts; this handles in-place conversation switches.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const el = list.getScrollableNode()
    el?.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
  }, [activeConversationId, listRef])

  const onSuggestionClick = useCallback(
    (prompt: string) => {
      resetIdleTimer()
      setMessage(prompt)
    },
    [resetIdleTimer],
  )

  const handleSend = useCallback(() => {
    const shouldNudgeAfterSend = showHomeContent || getIsNearBottom()
    if (showHomeContent) {
      setComposerFocusRequestId((id) => id + 1)
    }
    enterChatSurfaceForInteraction()
    resetIdleTimer()
    void sendMessage({
      text: message,
      selectedText,
      chatContext,
      onClear: () => {
        setMessage('')
        setSelectedText(null)
        setChatContext(null)
      },
    })
    if (shouldNudgeAfterSend) {
      const scrollToCurrentBottom = () => {
        const el = listRef.current?.getScrollableNode() as HTMLElement | null
        if (!el) return
        smoothScrollTo(
          el,
          el.scrollHeight - el.clientHeight,
          SENT_MESSAGE_SCROLL_NUDGE_MS,
        )
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToCurrentBottom()
          window.setTimeout(scrollToCurrentBottom, SENT_MESSAGE_SCROLL_SETTLE_DELAY_MS)
        })
      })
    }
  }, [
    chatContext,
    enterChatSurfaceForInteraction,
    getIsNearBottom,
    isAtBottom,
    listRef,
    message,
    resetIdleTimer,
    selectedText,
    sendMessage,
    setChatContext,
    setSelectedText,
    showHomeContent,
  ])

  const { canSubmit } = deriveComposerState({
    message,
    chatContext,
    selectedText,
    conversationId: activeConversationId,
    requireConversationId: true,
  })

  const chatColumnConversation = useMemo<ChatColumnConversation>(
    () => ({
      messages: displayMessages,
      activity: {
        activities,
        latestMessageTimestampMs,
        hasOlder: hasOlderActivity,
        isLoadingOlder: isLoadingOlderActivity,
        loadOlder: loadOlderActivity,
      },
      files: {
        files: persistedFiles,
        hasOlder: hasOlderFiles,
        isLoadingOlder: isLoadingOlderFiles,
        loadOlder: loadOlderFiles,
      },
      streaming: {
        text: streamingText,
        reasoningText,
        responseTarget: streamingResponseTarget,
        isStreaming,
        runtimeStatusText,
        pendingUserMessageId,
        queuedUserMessages,
        optimisticUserMessageIds: justSentUserMessageIds,
        liveTasks,
        taskProgressSummaries,
      },
      history: {
        hasOlderMessages,
        isLoadingOlder: isLoadingOlderMessages,
        isInitialLoading: isInitialLoadingMessages,
      },
    }),
    [
      activities,
      displayMessages,
      hasOlderActivity,
      hasOlderFiles,
      hasOlderMessages,
      isInitialLoadingMessages,
      isLoadingOlderActivity,
      isLoadingOlderFiles,
      isLoadingOlderMessages,
      justSentUserMessageIds,
      latestMessageTimestampMs,
      liveTasks,
      loadOlderActivity,
      loadOlderFiles,
      pendingUserMessageId,
      persistedFiles,
      queuedUserMessages,
      reasoningText,
      runtimeStatusText,
      streamingResponseTarget,
      streamingText,
      isStreaming,
      taskProgressSummaries,
    ],
  )

  const chatColumnComposer = useMemo<ChatColumnComposer>(
    () => ({
      message,
      setMessage,
      chatContext,
      setChatContext,
      selectedText,
      setSelectedText,
      canSubmit,
      focusRequestId: composerFocusRequestId,
      onSend: handleSend,
      onStop: cancelCurrentStream,
    }),
    [
      message,
      setMessage,
      chatContext,
      setChatContext,
      selectedText,
      setSelectedText,
      canSubmit,
      composerFocusRequestId,
      handleSend,
      cancelCurrentStream,
    ],
  )

  const chatColumnScroll = useMemo<ChatColumnScroll>(
    () => ({
      listRef,
      onListScroll,
      onStartReached,
      showScrollButton,
      isAtBottom,
      isNearBottom,
      getIsNearBottom,
      scrollToBottom,
      thumbState,
    }),
    [
      listRef,
      onListScroll,
      onStartReached,
      showScrollButton,
      isAtBottom,
      isNearBottom,
      getIsNearBottom,
      scrollToBottom,
      thumbState,
    ],
  )

  return {
    conversation: {
      ...chatColumnConversation,
      hasOlderMessages,
      isLoadingOlder: isLoadingOlderMessages,
      isInitialLoading: isInitialLoadingMessages,
      streamingText,
      reasoningText,
      streamingResponseTarget,
      isStreaming,
      pendingUserMessageId,
      queuedUserMessages,
      sendMessage,
      sendContextlessMessage,
      sendMessageWithContext,
      cancelCurrentStream,
    },
    composer: {
      ...chatColumnComposer,
      handleSend,
      handleStop: cancelCurrentStream,
    },
    scroll: chatColumnScroll,
    showHomeContent,
    onSuggestionClick,
    dismissHome,
    showHome,
  }
}
