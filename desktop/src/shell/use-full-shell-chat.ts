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
import { useTraceEventMonitor, useTraceIpcListener } from '@/debug/hooks/use-trace-listener'
import type { MessageMetadata } from '@/app/chat/lib/event-transforms'
import {
  STELLA_SEND_MESSAGE_EVENT,
  type StellaSendMessageDetail,
  toStellaMessageMetadata,
} from '@/shared/lib/stella-send-message'
import { useChatContextSync } from './use-chat-context-sync'
import { useChatScrollManagement } from './use-chat-scroll-management'

const NO_OP = () => {}

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
  activeView: import('@/shared/contracts/ui').ViewType
  isDev: boolean
}

export function useFullShellChat({
  activeConversationId,
  activeView,
  isDev,
}: UseFullShellChatOptions) {
  const [message, setMessage] = useState('')
  const { chatContext, setChatContext, selectedText, setSelectedText } =
    useChatContextSync()

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

  const sendContextlessMessage = useCallback(
    (text: string, metadata?: MessageMetadata) => {
      void sendMessageRef.current({
        text,
        selectedText: null,
        chatContext: null,
        onClear: NO_OP,
        metadata,
      })
    },
    [],
  )

  const sendMessageWithContext = useCallback(
    (
      text: string,
      chatCtx?: import('@/shared/types/electron').ChatContext | null,
      selectedTextCtx?: string | null,
    ) => {
      void sendMessageRef.current({
        text,
        selectedText: selectedTextCtx ?? null,
        chatContext: chatCtx ?? null,
        onClear: NO_OP,
      })
    },
    [],
  )

  // Scroll: column-reverse viewport; ResizeObserver follows newest unless paused while a reply is in flight.
  const {
    setScrollContainerElement,
    setContentElement,
    hasScrollElement,
    showScrollButton,
    scrollToBottom,
    scrollTurnToPinTop,
    handleScroll,
    resetScrollState,
    overflowAnchor,
    thumbState,
  } = useChatScrollManagement({
    itemCount: events.length,
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

  // Reset scroll when switching to chat view
  useLayoutEffect(() => {
    if (activeView !== 'chat') return
    return resetChatScroll(resetScrollState, scrollToBottom)
  }, [activeView, resetScrollState, scrollToBottom])

  const handleSend = useCallback(() => {
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
    message,
    selectedText,
    sendMessage,
    setChatContext,
    setSelectedText,
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
  }
}
