import { useCallback, useRef } from 'react'
import { issueQueuedDequeueTimestamp } from './queued-user-messages'

type Timestamped = { timestamp: number }

type UseQueuedDequeueClockOptions = {
  conversationId: string | null
  persistedMessages: readonly Timestamped[]
  optimisticEvents: readonly Timestamped[]
}

/**
 * Per-conversation logical clock for renderer-owned queue drains. Switching
 * conversations or remounting starts a fresh clock, while the current
 * transcript always supplies the lower bound for the next issued timestamp.
 */
export const useQueuedDequeueClock = ({
  conversationId,
  persistedMessages,
  optimisticEvents,
}: UseQueuedDequeueClockOptions) => {
  const stateRef = useRef({ conversationId, timelineFloor: 0 })
  if (stateRef.current.conversationId !== conversationId) {
    stateRef.current = { conversationId, timelineFloor: 0 }
  }

  return useCallback((wallClockMs = Date.now()) => {
    let transcriptFloor = stateRef.current.timelineFloor
    for (const message of persistedMessages) {
      transcriptFloor = Math.max(transcriptFloor, message.timestamp)
    }
    for (const event of optimisticEvents) {
      transcriptFloor = Math.max(transcriptFloor, event.timestamp)
    }
    const clock = issueQueuedDequeueTimestamp(
      wallClockMs,
      stateRef.current.timelineFloor,
      transcriptFloor,
    )
    stateRef.current.timelineFloor = clock.nextTimelineFloor
    return clock.userTimestamp
  }, [optimisticEvents, persistedMessages])
}
