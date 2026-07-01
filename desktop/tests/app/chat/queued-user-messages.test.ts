import { describe, expect, it } from 'vitest'
import {
  removeQueuedUserMessageById,
  restoreQueuedTextToComposer,
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

describe('restoreQueuedTextToComposer', () => {
  it('drops the cancelled message text straight into an empty composer', () => {
    expect(restoreQueuedTextToComposer('', 'edit me')).toBe('edit me')
    expect(restoreQueuedTextToComposer('   \n  ', 'edit me')).toBe('edit me')
  })

  it('appends below an existing draft without clobbering it', () => {
    expect(restoreQueuedTextToComposer('half a thought  ', 'recovered')).toBe(
      'half a thought\n\nrecovered',
    )
  })

  it('leaves the composer untouched when the restored text is blank', () => {
    expect(restoreQueuedTextToComposer('draft', '   ')).toBe('draft')
  })

  it('trims the restored text before inserting it', () => {
    expect(restoreQueuedTextToComposer('', '  padded  ')).toBe('padded')
  })
})
