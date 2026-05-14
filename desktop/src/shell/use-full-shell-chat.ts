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
import { useConversationEventFeed } from '@/app/chat/hooks/use-conversation-events'
import { useStreamingChat } from '@/app/chat/hooks/use-streaming-chat'
import { useTaskProgressSummaries } from '@/app/chat/hooks/use-task-progress-summaries'
import { useTraceEventMonitor, useTraceIpcListener } from '@/debug/hooks/use-trace-listener'
import { mergeEventSources } from '@/app/chat/lib/event-transforms'
import { useCapturedChatContext } from './use-captured-chat-context'
import { useChatScrollManagement } from './use-chat-scroll-management'
import { useChatHomeSurface } from './use-chat-home-surface'
import { useAgentInputRouting } from './use-agent-input-routing'
import { useStellaSendMessageBridge } from './use-stella-send-message-bridge'
import { smoothScrollTo } from '@/shared/lib/smooth-scroll'

const SENT_MESSAGE_SCROLL_NUDGE_MS = 360
const SENT_MESSAGE_SCROLL_SETTLE_DELAY_MS = 80

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
    isLoadingOlder,
    isInitialLoading,
    loadOlder,
  } = useConversationEventFeed(activeConversationId ?? undefined)

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
    hasOlderEvents,
    isLoadingOlder,
    onLoadOlder: loadOlder,
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
      events: displayEvents,
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
        hasOlderEvents,
        isLoadingOlder,
        isInitialLoading,
      },
    }),
    [
      displayEvents,
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
      hasOlderEvents,
      isLoadingOlder,
      isInitialLoading,
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
      hasOlderEvents,
      isLoadingOlder,
      isInitialLoading,
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
