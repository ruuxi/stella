import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
import { useIdleHomeVisibility } from '@/app/chat/hooks/use-idle-home-visibility'
import { useTraceEventMonitor, useTraceIpcListener } from '@/debug/hooks/use-trace-listener'
import type { MessageMetadata } from '@/app/chat/lib/event-transforms'
import {
  STELLA_SEND_MESSAGE_EVENT,
  type StellaSendMessageDetail,
  toStellaMessageMetadata,
} from '@/shared/lib/stella-send-message'
import { STELLA_SHOW_HOME_EVENT } from '@/shared/lib/stella-orb-chat'
import { useCapturedChatContext } from './use-captured-chat-context'
import { useChatScrollManagement } from './use-chat-scroll-management'

const NO_OP = () => {}

/** Set when navigating away from chat; cleared on full app restart (new session). */
const SESSION_LEFT_CHAT_KEY = 'stella_left_chat_once'

const resetChatScroll = (
  resetScrollState: () => void,
  scrollToBottom: (behavior: 'instant' | 'smooth') => void,
) => {
  resetScrollState()
  scrollToBottom('instant')
  const raf = requestAnimationFrame(() => {
    scrollToBottom('instant')
  })
  return () => cancelAnimationFrame(raf)
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
  const [leftChatOnce, setLeftChatOnce] = useState(() => {
    if (typeof sessionStorage === 'undefined') return false
    return sessionStorage.getItem(SESSION_LEFT_CHAT_KEY) === '1'
  })
  const [hasInteractedWithChatThisSession, setHasInteractedWithChatThisSession] =
    useState(false)
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0)
  const prevOnChatRouteRef = useRef(isOnChatRoute)
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
    runtimeStatusText,
    streamingText,
    reasoningText,
    streamingResponseTarget,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    sendMessage,
    cancelCurrentStream,
  } = useStreamingChat({
    conversationId: activeConversationId,
    events,
  })

  useTraceIpcListener(isDev)
  useTraceEventMonitor(isDev, events)

  const sendMessageRef = useRef(sendMessage)

  useEffect(() => {
    sendMessageRef.current = sendMessage
  }, [sendMessage])

  const markHomeSessionInteraction = useCallback(() => {
    setHasInteractedWithChatThisSession(true)
  }, [])

  const sendContextlessMessage = useCallback(
    (text: string, metadata?: MessageMetadata) => {
      markHomeSessionInteraction()
      void sendMessageRef.current({
        text,
        selectedText: null,
        chatContext: null,
        onClear: NO_OP,
        metadata,
      })
    },
    [markHomeSessionInteraction],
  )

  const sendMessageWithContext = useCallback(
    (
      text: string,
      chatCtx?: import('@/shared/types/electron').ChatContext | null,
      selectedTextCtx?: string | null,
    ) => {
      markHomeSessionInteraction()
      void sendMessageRef.current({
        text,
        selectedText: selectedTextCtx ?? null,
        chatContext: chatCtx ?? null,
        onClear: NO_OP,
      })
    },
    [markHomeSessionInteraction],
  )

  const hasMessages = events.length > 0

  const { showHomeContent: idleBasedHome, resetIdleTimer, forceShowHome } = useIdleHomeVisibility({
    hasMessages,
    isStreaming,
  })

  const firstStintOnChat = !leftChatOnce && isOnChatRoute
  const showHomeContent = firstStintOnChat
    ? !hasMessages ||
      !hasInteractedWithChatThisSession ||
      idleBasedHome
    : idleBasedHome

  useEffect(() => {
    if (prevOnChatRouteRef.current && !isOnChatRoute) {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_LEFT_CHAT_KEY, '1')
      }
      queueMicrotask(() => {
        setLeftChatOnce(true)
      })
    }
    prevOnChatRouteRef.current = isOnChatRoute
  }, [isOnChatRoute])

  const onSuggestionClick = useCallback((prompt: string) => {
    resetIdleTimer()
    setMessage(prompt)
  }, [resetIdleTimer])

  const dismissHome = useCallback(() => {
    resetIdleTimer()
    markHomeSessionInteraction()
  }, [resetIdleTimer, markHomeSessionInteraction])

  const showHome = useCallback(() => {
    forceShowHome()
  }, [forceShowHome])

  useEffect(() => {
    const handler = () => forceShowHome()
    window.addEventListener(STELLA_SHOW_HOME_EVENT, handler)
    return () => window.removeEventListener(STELLA_SHOW_HOME_EVENT, handler)
  }, [forceShowHome])

  // Scroll: column-reverse viewport; ResizeObserver follows newest unless paused while a reply is in flight.
  const {
    setScrollContainerElement,
    setContentElement,
    hasScrollElement,
    isNearBottom,
    showScrollButton,
    scrollToBottom,
    scrollTurnToPinTop,
    handleScroll,
    resetScrollState,
    overflowAnchor,
    thumbState,
  } = useChatScrollManagement({
    hasOlderEvents,
    isLoadingOlder,
    onLoadOlder: loadOlder,
    isWorking: isStreaming,
    pauseResizeFollow: Boolean(pendingUserMessageId),
  })

  // Reset scroll on conversation change
  useLayoutEffect(() => {
    return resetChatScroll(resetScrollState, scrollToBottom)
  }, [activeConversationId, resetScrollState, scrollToBottom])

  useLayoutEffect(() => {
    if (!isOnChatRoute) return
    return resetChatScroll(resetScrollState, scrollToBottom)
  }, [isOnChatRoute, resetScrollState, scrollToBottom])

  const handleSend = useCallback(() => {
    if (showHomeContent) {
      setComposerFocusRequestId((id) => id + 1)
    }
    markHomeSessionInteraction()
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
  }, [
    chatContext,
    markHomeSessionInteraction,
    message,
    resetIdleTimer,
    selectedText,
    sendMessage,
    setChatContext,
    setSelectedText,
    showHomeContent,
  ])

  useEffect(() => {
    const handleSuggestionMessage = (event: Event) => {
      const detail = (event as CustomEvent<StellaSendMessageDetail>).detail
      if (detail?.text) {
        sendContextlessMessage(detail.text, toStellaMessageMetadata(detail))
      }
    }

    window.addEventListener(STELLA_SEND_MESSAGE_EVENT, handleSuggestionMessage)
    return () => {
      window.removeEventListener(STELLA_SEND_MESSAGE_EVENT, handleSuggestionMessage)
    }
  }, [sendContextlessMessage])

  const { canSubmit } = deriveComposerState({
    message,
    chatContext,
    selectedText,
    conversationId: activeConversationId,
    requireConversationId: true,
  })

  const chatColumnConversation = useMemo<ChatColumnConversation>(
    () => ({
      events,
      streaming: {
        text: streamingText,
        reasoningText,
        responseTarget: streamingResponseTarget,
        isStreaming,
        runtimeStatusText,
        pendingUserMessageId,
        selfModMap,
        liveTasks,
      },
      history: {
        hasOlderEvents,
        isLoadingOlder,
        isInitialLoading,
      },
    }),
    [
      events,
      streamingText,
      reasoningText,
      streamingResponseTarget,
      isStreaming,
      runtimeStatusText,
      pendingUserMessageId,
      selfModMap,
      liveTasks,
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
      setViewportElement: setScrollContainerElement,
      setContentElement,
      onScroll: handleScroll,
      showScrollButton,
      isAtBottom: isNearBottom,
      scrollToBottom,
      scrollTurnToPinTop,
      overflowAnchor,
      thumbState,
      hasScrollElement,
    }),
    [
      setScrollContainerElement,
      setContentElement,
      handleScroll,
      showScrollButton,
      isNearBottom,
      scrollToBottom,
      scrollTurnToPinTop,
      overflowAnchor,
      thumbState,
      hasScrollElement,
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
      selfModMap,
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
    scroll: {
      ...chatColumnScroll,
      hasScrollElement,
      setScrollContainerElement,
    },
    showHomeContent,
    onSuggestionClick,
    dismissHome,
    showHome,
  }
}
