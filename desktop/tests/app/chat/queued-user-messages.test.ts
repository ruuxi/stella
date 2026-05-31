import { describe, expect, it } from 'vitest'
import {
  removeQueuedUserMessageById,
  shouldClearQueuedUserMessagesForRunOutcome,
  type QueuedUserMessage,
} from '../../../src/features/chat/hooks/queued-user-messages'

const queued = (
  id: string,
  timestamp: number,
  text = id,
): QueuedUserMessage => ({
  id,
  timestamp,
  text,
})

describe('queued user message cleanup', () => {
  it('removes the accepted queued message without touching other queued messages', () => {
    expect(
      removeQueuedUserMessageById(
        [queued('queued-1', 100), queued('queued-2', 200)],
        'queued-1',
      ),
    ).toEqual([queued('queued-2', 200)])
  })

  it('clears queued messages when the run fails or is canceled before acceptance', () => {
    expect(shouldClearQueuedUserMessagesForRunOutcome('completed')).toBe(false)
    expect(shouldClearQueuedUserMessagesForRunOutcome('error')).toBe(true)
    expect(shouldClearQueuedUserMessagesForRunOutcome('canceled')).toBe(true)
  })
})
