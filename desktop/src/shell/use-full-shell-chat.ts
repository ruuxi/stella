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
import { useConversationEventFeed } from '@/app/chat/hooks/use-conversation-events'
import { useConversationFiles } from '@/app/chat/hooks/use-conversation-files'
import { useConversationMessages } from '@/app/chat/hooks/use-conversation-messages'
import { useStreamingChat } from '@/app/chat/hooks/use-streaming-chat'
import { useTaskProgressSummaries } from '@/app/chat/hooks/use-task-progress-summaries'
import { useTraceEventMonitor, useTraceIpcListener } from '@/debug/hooks/use-trace-listener'
import {
  mergeEventSources,
  type EventRecord,
} from '@/app/chat/lib/event-transforms'
import { groupEventsIntoMessages } from '@/app/chat/lib/group-events-into-messages'
import { useChatStore } from '@/context/chat-store'
import type { MessageRecord } from '../../../runtime/contracts/local-chat.js'
import { useCapturedChatContext } from './use-captured-chat-context'
import { useChatScrollManagement } from './use-chat-scroll-management'
import { useChatHomeSurface } from './use-chat-home-surface'
import { useAgentInputRouting } from './use-agent-input-routing'
import { useStellaSendMessageBridge } from './use-stella-send-message-bridge'
import { smoothScrollTo } from '@/shared/lib/smooth-scroll'

const SENT_MESSAGE_SCROLL_NUDGE_MS = 360
const SENT_MESSAGE_SCROLL_SETTLE_DELAY_MS = 80

const ACTIVITY_EVENT_TYPES = new Set([
  'agent-started',
  'agent-progress',
  'agent-completed',
  'agent-failed',
  'agent-canceled',
])

const FILE_CARRYING_EVENT_TYPES = new Set(['tool_result', 'agent-completed'])

const eventCarriesFileChanges = (event: EventRecord): boolean => {
  const payload = event.payload as
    | { fileChanges?: unknown; producedFiles?: unknown }
    | undefined
  if (!payload || typeof payload !== 'object') return false
  if (Array.isArray(payload.fileChanges) && payload.fileChanges.length > 0) return true
  if (Array.isArray(payload.producedFiles) && payload.producedFiles.length > 0) return true
  return false
}

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
    events,
    hasOlderEvents,
    isLoadingOlder: isLoadingOlderEvents,
    isInitialLoading: isInitialLoadingEvents,
    loadOlder: loadOlderEvents,
  } = useConversationEventFeed(activeConversationId ?? undefined)

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
    events,
  })
  const displayEvents = useMemo(
    () => mergeEventSources(events, optimisticEvents),
    [events, optimisticEvents],
  )

  // Visible chat timeline source.
  //
  // - Local mode: start from the SQLite-backed `persistedMessages` (which
  //   already carry per-turn tool events), then overlay scheduled events
  //   (cron/heartbeat user messages projected to MessageRecord) and the
  //   optimistic just-sent overlay so the chat surface is up-to-date
  //   before the runtime persists.
  //
  // - Cloud mode: there is no `listMessages` IPC against Convex yet;
  //   project the full event stream (cloud events + optimistic + any
  //   scheduled overlay already merged in by `useConversationEventFeed`)
  //   into messages via the renderer-side grouper so the timeline still
  //   renders. Phase 2/3 decides whether to add a cloud-side
  //   `listMessages` equivalent or drop cloud mode altogether.
  const { storageMode } = useChatStore()
  const isLocalMode = storageMode === 'local'

  // Activity inputs for `extractTasksFromActivities`. Local mode reads
  // the agent-* lifecycle stream directly from SQLite via
  // `useConversationActivity`; cloud mode falls back to filtering the
  // merged event stream (no cloud `listActivity` IPC yet) so the
  // working indicator / Now / Done surfaces keep working there too.
  const activityInputs = useMemo(() => {
    if (isLocalMode) {
      return { activities, latestMessageTimestampMs }
    }
    let latest: number | null = null
    const filtered: EventRecord[] = []
    for (const event of displayEvents) {
      if (event.type === 'user_message' || event.type === 'assistant_message') {
        if (latest === null || event.timestamp > latest) latest = event.timestamp
        continue
      }
      if (ACTIVITY_EVENT_TYPES.has(event.type)) filtered.push(event)
    }
    return { activities: filtered, latestMessageTimestampMs: latest }
  }, [activities, displayEvents, isLocalMode, latestMessageTimestampMs])

  // File-carrying events feeding the Recent Files surfaces. Local mode
  // reads from SQLite via `useConversationFiles`; cloud mode falls back
  // to a `displayEvents` filter so cloud chats still surface recent
  // files until a cloud `listFiles` equivalent lands.
  const fileEvents = useMemo<EventRecord[]>(() => {
    if (isLocalMode) return persistedFiles
    return displayEvents.filter(
      (event) =>
        FILE_CARRYING_EVENT_TYPES.has(event.type) &&
        eventCarriesFileChanges(event),
    )
  }, [displayEvents, isLocalMode, persistedFiles])

  const overlayMessagesFromEvents = useMemo(() => {
    if (!isLocalMode) return [] as MessageRecord[]
    // Project just the scheduled + optimistic event overlays — not the
    // SQLite-backed `events`, since `persistedMessages` already covers
    // those (and does so with the correct visible-message-count window).
    // `events` minus `displayEvents` would be brittle; instead derive
    // the overlay set directly from the only two synthetic sources we
    // care about here.
    const overlayEvents: EventRecord[] = []
    for (const event of optimisticEvents) overlayEvents.push(event)
    // Scheduled events ride through `useConversationEventFeed`'s local
    // stream as well, but those that haven't been persisted yet (still
    // pending in the scheduler) only exist there — the `events` array
    // therefore is the lower-cost place to look them up.
    for (const event of events) {
      if (event.type !== 'user_message' && event.type !== 'assistant_message')
        continue
      // Skip events already in persistedMessages — that's the canonical
      // copy with toolEvents attached.
      if (overlayEvents.some((other) => other._id === event._id)) continue
      overlayEvents.push(event)
    }
    return groupEventsIntoMessages(overlayEvents)
  }, [events, isLocalMode, optimisticEvents])

  const displayMessages = useMemo(() => {
    if (isLocalMode) {
      if (overlayMessagesFromEvents.length === 0) return persistedMessages
      return mergeMessageSources(persistedMessages, overlayMessagesFromEvents)
    }
    return groupEventsIntoMessages(displayEvents)
  }, [
    displayEvents,
    isLocalMode,
    overlayMessagesFromEvents,
    persistedMessages,
  ])
  const timelineHasOlderMessages = isLocalMode ? hasOlderMessages : hasOlderEvents
  const timelineIsLoadingOlder = isLocalMode
    ? isLoadingOlderMessages
    : isLoadingOlderEvents
  const timelineIsInitialLoading = isLocalMode
    ? isInitialLoadingMessages
    : isInitialLoadingEvents
  const timelineLoadOlder = isLocalMode ? loadOlderMessages : loadOlderEvents
  const taskProgressSummaries = useTaskProgressSummaries({ liveTasks, events })

  useTraceIpcListener(isDev)
  useTraceEventMonitor(isDev, displayEvents)

  const hasMessages = displayEvents.length > 0

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
    hasOlderEvents: timelineHasOlderMessages,
    isLoadingOlder: timelineIsLoadingOlder,
    onLoadOlder: timelineLoadOlder,
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
      events: displayEvents,
      activity: {
        activities: activityInputs.activities,
        latestMessageTimestampMs: activityInputs.latestMessageTimestampMs,
        hasOlder: isLocalMode ? hasOlderActivity : false,
        isLoadingOlder: isLocalMode ? isLoadingOlderActivity : false,
        loadOlder: isLocalMode ? loadOlderActivity : () => {},
      },
      files: {
        files: fileEvents,
        hasOlder: isLocalMode ? hasOlderFiles : false,
        isLoadingOlder: isLocalMode ? isLoadingOlderFiles : false,
        loadOlder: isLocalMode ? loadOlderFiles : () => {},
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
        hasOlderMessages: timelineHasOlderMessages,
        isLoadingOlder: timelineIsLoadingOlder,
        isInitialLoading: timelineIsInitialLoading,
      },
    }),
    [
      activityInputs,
      displayMessages,
      displayEvents,
      fileEvents,
      hasOlderActivity,
      hasOlderFiles,
      isLoadingOlderActivity,
      isLoadingOlderFiles,
      isLocalMode,
      loadOlderActivity,
      loadOlderFiles,
      streamingText,
      reasoningText,
      streamingResponseTarget,
      isStreaming,
      runtimeStatusText,
      pendingUserMessageId,
      queuedUserMessages,
      justSentUserMessageIds,
      liveTasks,
      taskProgressSummaries,
      timelineHasOlderMessages,
      timelineIsLoadingOlder,
      timelineIsInitialLoading,
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
      hasOlderMessages: timelineHasOlderMessages,
      hasOlderEvents,
      isLoadingOlder: timelineIsLoadingOlder,
      isLoadingOlderEvents,
      isInitialLoading: timelineIsInitialLoading,
      isInitialLoadingEvents,
      loadOlderEvents,
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
