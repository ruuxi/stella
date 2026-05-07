import { useEffect } from 'react'
import {
  STELLA_SEND_MESSAGE_EVENT,
  type StellaSendMessageDetail,
  toStellaMessageMetadata,
} from '@/shared/lib/stella-send-message'
import type { MessageMetadata } from '@/app/chat/lib/event-transforms'

type UseStellaSendMessageBridgeOptions = {
  sendContextlessMessage: (text: string, metadata?: MessageMetadata) => void
  sendAgentInputMessage: (
    detail: StellaSendMessageDetail,
    metadata?: MessageMetadata,
  ) => void
}

/**
 * Bridge `STELLA_SEND_MESSAGE_EVENT` window events into chat sends.
 *
 * Suggestion chips, the radial dial, and the orchestrator's hidden
 * follow-ups all dispatch the same event; the routing call here
 * decides whether to send into the active conversation or into a
 * specific routed agent (when `targetAgentId` is present).
 */
export function useStellaSendMessageBridge({
  sendContextlessMessage,
  sendAgentInputMessage,
}: UseStellaSendMessageBridgeOptions): void {
  useEffect(() => {
    const handleSuggestionMessage = (event: Event) => {
      const detail = (event as CustomEvent<StellaSendMessageDetail>).detail
      if (!detail?.text) return
      const metadata = toStellaMessageMetadata(detail)
      if (detail.targetAgentId) {
        sendAgentInputMessage(detail, metadata)
        return
      }
      sendContextlessMessage(detail.text, metadata)
    }

    window.addEventListener(STELLA_SEND_MESSAGE_EVENT, handleSuggestionMessage)
    return () => {
      window.removeEventListener(
        STELLA_SEND_MESSAGE_EVENT,
        handleSuggestionMessage,
      )
    }
  }, [sendAgentInputMessage, sendContextlessMessage])
}
