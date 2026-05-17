import { useCallback, useEffect, useRef } from 'react'
import type { MessageMetadata } from '@/app/chat/lib/event-transforms'
import type { ChatContext } from '@/shared/types/electron'
import type { SendMessageArgs } from '@/app/chat/streaming/chat-types'
import type { StellaSendMessageDetail } from '@/shared/lib/stella-send-message'

const NO_OP = () => {}

type UseAgentInputRoutingOptions = {
  activeConversationId: string | null
  /** Resolved at call-time via a ref so we never close over a stale identity. */
  sendMessage: (args: SendMessageArgs) => void | Promise<void>
  enterChatSurfaceForInteraction: () => void
}

type UseAgentInputRoutingResult = {
  /** Send `text` to the active conversation, no chip context. */
  sendContextlessMessage: (text: string, metadata?: MessageMetadata) => void
  /** Route into a named target agent if present, falling back to chat. */
  sendAgentInputMessage: (
    detail: StellaSendMessageDetail,
    metadata?: MessageMetadata,
  ) => void
  /** Send `text` plus optional captured context (for the orb/radial flows). */
  sendMessageWithContext: (
    text: string,
    chatCtx?: ChatContext | null,
    selectedTextCtx?: string | null,
  ) => void
}

/**
 * Three thin sugar wrappers around `useStreamingChat`'s `sendMessage`
 * that the shell uses to fan out IPC / window-event sends into the
 * conversation. Routes messages with `targetAgentId` to that agent's
 * input bus instead of the active conversation.
 */
export function useAgentInputRouting({
  activeConversationId,
  sendMessage,
  enterChatSurfaceForInteraction,
}: UseAgentInputRoutingOptions): UseAgentInputRoutingResult {
  const sendMessageRef = useRef(sendMessage)
  useEffect(() => {
    sendMessageRef.current = sendMessage
  }, [sendMessage])

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
      if (
        !threadId ||
        !activeConversationId ||
        !window.electronAPI?.agent?.sendInput
      ) {
        sendContextlessMessage(detail.text, metadata)
        return
      }
      enterChatSurfaceForInteraction()
      void window.electronAPI.agent
        .sendInput({
          conversationId: activeConversationId,
          threadId,
          message: detail.text,
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
      chatCtx?: ChatContext | null,
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

  return {
    sendContextlessMessage,
    sendAgentInputMessage,
    sendMessageWithContext,
  }
}
