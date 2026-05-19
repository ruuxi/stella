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
import { useConversationDisplayMessages } from '@/app/chat/hooks/use-conversation-display-messages'
import { useConversationFiles } from '@/app/chat/hooks/use-conversation-files'
import { useConversationMessages } from '@/app/chat/hooks/use-conversation-messages'
import { useStreamingChat } from '@/app/chat/hooks/use-streaming-chat'
import { useTaskProgressSummaries } from '@/app/chat/hooks/use-task-progress-summaries'
import { useTraceEventMonitor, useTraceIpcListener } from '@/debug/hooks/use-trace-listener'
import { type EventRecord } from '@/app/chat/lib/event-transforms'
import { useCapturedChatContext } from './use-captured-chat-context'
import { useChatScrollManagement } from './use-chat-scroll-management'
import { useChatHomeSurface } from './use-chat-home-surface'
import { useAgentInputRouting } from './use-agent-input-routing'
import { useStellaSendMessageBridge } from './use-stella-send-message-bridge'

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

  const {
    liveTasks,
    optimisticEvents,
    runtimeStatusText,
    reasoningText,
    streamingAssistants,
    isStreaming,
    pendingUserMessageId,
    queuedUserMessages,
    sendMessage,
    cancelCurrentStream,
  } = useStreamingChat({
    conversationId: activeConversationId,
    persistedMessages,
  })

  // Visible chat timeline: SQLite-backed `persistedMessages` plus the
  // synthetic overlays (optimistic users, in-memory streaming
  // assistants, scheduler-pending) that drop off as their persisted
  // counterparts land. Lives in its own hook so the overlay-
  // composition concerns stay next to each other.
  const displayMessages = useConversationDisplayMessages({
    conversationId: activeConversationId,
    persistedMessages,
    optimisticEvents,
    streamingAssistants,
  })

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
    getIsFollowing,
    showScrollButton,
    scrollToBottom,
    releaseFollow,
    nudgeAfterSend,
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
    // `getIsFollowing()` reads the follow latch (intent), not the
    // physical scroll position. After a short assistant reply, the
    // user is visually at the bottom of the conversation but ~150px
    // physically above the absolute end (because the trailing-region
    // footer is off-screen below the latest text).
    const shouldNudgeAfterSend = showHomeContent || getIsFollowing()
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
      // Routes the small post-send bump through the same lerp loop
      // as streaming auto-follow so the two motions blend rather
      // than fight via separate concurrent rAF tweens.
      nudgeAfterSend()
    } else {
      releaseFollow()
    }
  }, [
    chatContext,
    enterChatSurfaceForInteraction,
    getIsFollowing,
    message,
    nudgeAfterSend,
    releaseFollow,
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
        reasoningText,
        isStreaming,
        runtimeStatusText,
        pendingUserMessageId,
        queuedUserMessages,
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
      latestMessageTimestampMs,
      liveTasks,
      loadOlderActivity,
      loadOlderFiles,
      pendingUserMessageId,
      persistedFiles,
      queuedUserMessages,
      reasoningText,
      runtimeStatusText,
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
      scrollToBottom,
      thumbState,
    }),
    [
      listRef,
      onListScroll,
      onStartReached,
      showScrollButton,
      isAtBottom,
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
      loadOlderMessages,
      reasoningText,
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
