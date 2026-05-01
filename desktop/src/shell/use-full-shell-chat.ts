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
import { useTaskProgressSummaries } from '@/app/chat/hooks/use-task-progress-summaries'
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
const CHAT_HOME_SURFACE_STORAGE_KEY = 'stella.chatHomeSurface'

type ChatHomeSurface = 'home' | 'chat'

function readPersistedChatHomeSurface(): ChatHomeSurface | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(CHAT_HOME_SURFACE_STORAGE_KEY)
    return raw === 'home' || raw === 'chat' ? raw : null
  } catch {
    return null
  }
}

function writePersistedChatHomeSurface(surface: ChatHomeSurface): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(CHAT_HOME_SURFACE_STORAGE_KEY, surface)
  } catch {
    // Storage is best-effort; the chat route itself still restores normally.
  }
}

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
  const [isHomeDismissed, setIsHomeDismissed] = useState(
    () => readPersistedChatHomeSurface() === 'chat',
  )
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0)
  const prevOnChatRouteRef = useRef(isOnChatRoute)
  const prevConversationIdRef = useRef(activeConversationId)
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
  const taskProgressSummaries = useTaskProgressSummaries({ liveTasks, events })

  useTraceIpcListener(isDev)
  useTraceEventMonitor(isDev, events)

  const sendMessageRef = useRef(sendMessage)

  useEffect(() => {
    sendMessageRef.current = sendMessage
  }, [sendMessage])

  const enterChatSurfaceForInteraction = useCallback(() => {
    setHasInteractedWithChatThisSession(true)
    setIsHomeDismissed(true)
    writePersistedChatHomeSurface('chat')
  }, [])

  const sendContextlessMessage = useCallback(
    (text: string, metadata?: MessageMetadata) => {
      enterChatSurfaceForInteraction()
      void sendMessageRef.current({
        text,
        selectedText: null,
        chatContext: null,
        onClear: NO_OP,
        metadata,
      })
    },
    [enterChatSurfaceForInteraction],
  )

  const sendAgentInputMessage = useCallback(
    (detail: StellaSendMessageDetail, metadata?: MessageMetadata) => {
      const threadId = detail.targetAgentId?.trim()
      if (!threadId || !activeConversationId || !window.electronAPI?.agent?.sendInput) {
        sendContextlessMessage(detail.text, metadata)
        return
      }
      enterChatSurfaceForInteraction()
      void window.electronAPI.agent
        .sendInput({
          conversationId: activeConversationId,
          threadId,
          message: detail.text,
          interrupt: true,
          ...(metadata ? { metadata } : {}),
        })
        .catch((error) => {
          console.error(
            'Failed to send routed agent input:',
            (error as Error).message,
          )
          sendContextlessMessage(detail.text, metadata)
        })
    },
    [activeConversationId, enterChatSurfaceForInteraction, sendContextlessMessage],
  )

  const sendMessageWithContext = useCallback(
    (
      text: string,
      chatCtx?: import('@/shared/types/electron').ChatContext | null,
      selectedTextCtx?: string | null,
    ) => {
      enterChatSurfaceForInteraction()
      void sendMessageRef.current({
        text,
        selectedText: selectedTextCtx ?? null,
        chatContext: chatCtx ?? null,
        onClear: NO_OP,
      })
    },
    [enterChatSurfaceForInteraction],
  )

  const hasMessages = events.length > 0

  const { showHomeContent: idleBasedHome, resetIdleTimer, forceShowHome } = useIdleHomeVisibility({
    hasMessages,
    isStreaming,
  })

  const firstStintOnChat = !leftChatOnce && isOnChatRoute
  const baseShowHomeContent = firstStintOnChat
    ? !hasMessages ||
      !hasInteractedWithChatThisSession ||
      idleBasedHome
    : idleBasedHome
  // An explicit dismiss (the "Back to chat" link) overrides the default
  // "no messages → show home" behavior; otherwise empty conversations could
  // never escape the home overlay. Cleared on real interaction or on
  // switching to a different conversation.
  const showHomeContent = isHomeDismissed ? false : baseShowHomeContent

  useEffect(() => {
    if (prevConversationIdRef.current === activeConversationId) return
    const hadConversation = Boolean(prevConversationIdRef.current)
    prevConversationIdRef.current = activeConversationId
    if (hadConversation) {
      queueMicrotask(() => {
        setIsHomeDismissed(false)
      })
    }
  }, [activeConversationId])

  useEffect(() => {
    if (!isOnChatRoute) return
    writePersistedChatHomeSurface(showHomeContent ? 'home' : 'chat')
  }, [isOnChatRoute, showHomeContent])

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
    setIsHomeDismissed(true)
    writePersistedChatHomeSurface('chat')
  }, [])

  const showHome = useCallback(() => {
    setIsHomeDismissed(false)
    writePersistedChatHomeSurface('home')
    forceShowHome()
  }, [forceShowHome])

  useEffect(() => {
    const handler = () => {
      setIsHomeDismissed(false)
      writePersistedChatHomeSurface('home')
      forceShowHome()
    }
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
  }, [
    chatContext,
    enterChatSurfaceForInteraction,
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
        const metadata = toStellaMessageMetadata(detail)
        if (detail.targetAgentId) {
          sendAgentInputMessage(detail, metadata)
          return
        }
        sendContextlessMessage(detail.text, metadata)
      }
    }

    window.addEventListener(STELLA_SEND_MESSAGE_EVENT, handleSuggestionMessage)
    return () => {
      window.removeEventListener(STELLA_SEND_MESSAGE_EVENT, handleSuggestionMessage)
    }
  }, [sendAgentInputMessage, sendContextlessMessage])

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
        taskProgressSummaries,
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
