import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CommandSuggestion } from '@/hooks/use-command-suggestions'
import { useConversationEventFeed } from '@/hooks/use-conversation-events'
import { useReturnDetection, formatDuration } from '@/hooks/use-return-detection'
import { useStreamingChat } from '@/hooks/use-streaming-chat'
import { useTraceEventMonitor, useTraceIpcListener } from '@/hooks/use-trace-listener'
import { hasComposerContext } from '@/hooks/streaming/message-context'
import { useChatContextSync } from './use-chat-context-sync'
import { useScrollManagement } from './use-full-shell'

const NO_OP = () => {}

type UseFullShellChatOptions = {
  activeConversationId: string | null
  activeView: 'home' | 'app' | 'chat'
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
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    sendMessage,
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

  const sendContextlessMessage = useCallback((text: string) => {
    void sendMessageRef.current({
      text,
      selectedText: null,
      chatContext: null,
      onClear: NO_OP,
    })
  }, [])

  const handleUserReturn = useCallback(
    (awayMs: number) => {
      sendContextlessMessage(
        `[System: The user has returned after being away for ${formatDuration(awayMs)}.]`,
      )
    },
    [sendContextlessMessage],
  )

  useReturnDetection({
    enabled: Boolean(activeConversationId),
    onReturn: handleUserReturn,
  })

  const {
    scrollContainerRef,
    isNearBottomRef,
    showScrollButton,
    scrollToBottom,
    handleScroll,
    resetScrollState,
  } = useScrollManagement({
    itemCount: events.length,
    hasOlderEvents,
    isLoadingOlder,
    onLoadOlder: loadOlder,
  })

  useLayoutEffect(() => {
    resetScrollState()
    scrollToBottom('instant')
    const raf = requestAnimationFrame(() => {
      scrollToBottom('instant')
    })

    return () => cancelAnimationFrame(raf)
  }, [activeConversationId, resetScrollState, scrollToBottom])

  useLayoutEffect(() => {
    if (activeView !== 'chat') return

    resetScrollState()
    scrollToBottom('instant')
    const raf = requestAnimationFrame(() => {
      scrollToBottom('instant')
    })

    return () => cancelAnimationFrame(raf)
  }, [activeView, resetScrollState, scrollToBottom])

  useLayoutEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom('instant')
    }
  }, [events.length, isNearBottomRef, scrollToBottom])

  useLayoutEffect(() => {
    if (isStreaming && isNearBottomRef.current) {
      scrollToBottom('instant')
    }
  }, [isStreaming, isNearBottomRef, reasoningText, scrollToBottom, streamingText])

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
  }, [chatContext, message, selectedText, sendMessage, setChatContext, setSelectedText])

  const handleCommandSelect = useCallback(
    (suggestion: CommandSuggestion) => {
      sendContextlessMessage(
        `Run the command "${suggestion.name}" (${suggestion.description}). Create a task for the general agent with command_id "${suggestion.commandId}", using the current or most recently used thread.`,
      )
    },
    [sendContextlessMessage],
  )

  useEffect(() => {
    const handleSuggestionMessage = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string }>).detail
      if (detail?.text) {
        sendContextlessMessage(detail.text)
      }
    }

    window.addEventListener('stella:send-message', handleSuggestionMessage)
    return () => {
      window.removeEventListener('stella:send-message', handleSuggestionMessage)
    }
  }, [sendContextlessMessage])

  const canSubmit = Boolean(
    activeConversationId && (message.trim() || hasComposerContext(chatContext, selectedText)),
  )

  return {
    conversation: {
      events,
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
    },
    composer: {
      message,
      setMessage,
      chatContext,
      setChatContext,
      selectedText,
      setSelectedText,
      canSubmit,
      handleSend,
      handleCommandSelect,
    },
    scroll: {
      scrollContainerRef,
      handleScroll,
      showScrollButton,
      scrollToBottom,
    },
  }
}
