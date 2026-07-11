import { describe, expect, it } from 'vitest'
import {
  combineQueuedSendPayloads,
  issueQueuedDequeueTimestamp,
  orderQueuedMessages,
  removeQueuedUserMessageById,
  restoreQueuedMessagesAfterFailedDrain,
  restoreQueuedTextToComposer,
  timestampQueuedOptimisticEventForDrain,
  type CombinableQueuedSendPayload,
  type QueuedUserMessage,
} from '../../../src/features/chat/hooks/queued-user-messages'

const queued = (
  id: string,
  timestamp: number,
  text = id,
): QueuedUserMessage => ({
  id,
  timestamp,
  queueOrder: timestamp,
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
})

describe('queued user message drain timestamp', () => {
  it('moves the optimistic row from enqueue time to dequeue time', () => {
    const enqueued = {
      _id: 'queued-1',
      timestamp: 100,
      payload: { text: 'follow up' },
    }

    const dequeued = timestampQueuedOptimisticEventForDrain(enqueued, 400)

    expect(dequeued).toEqual({ ...enqueued, timestamp: 400 })
    expect(dequeued).not.toBe(enqueued)
    expect(enqueued.timestamp).toBe(100)
  })

  it('advances past a same-millisecond transcript timestamp', () => {
    expect(issueQueuedDequeueTimestamp(400, 0, 400)).toEqual({
      userTimestamp: 401,
      nextTimelineFloor: 402,
    })
  })

  it('does not go backward when the wall clock regresses', () => {
    expect(issueQueuedDequeueTimestamp(300, 402, 350)).toEqual({
      userTimestamp: 403,
      nextTimelineFloor: 404,
    })
  })

  it('keeps separate same-millisecond drain cycles strictly ordered', () => {
    const first = issueQueuedDequeueTimestamp(500, 0, 499)
    const second = issueQueuedDequeueTimestamp(
      500,
      first.nextTimelineFloor,
      499,
    )

    expect(first.userTimestamp).toBe(500)
    expect(second.userTimestamp).toBe(502)
    expect(second.userTimestamp).toBeGreaterThan(first.nextTimelineFloor)
  })
})

type TestPayload = CombinableQueuedSendPayload & {
  conversationId: string
  deviceId: string
  optimisticEvent: { _id: string; timestamp: number }
}

const payload = (
  id: string,
  userPrompt: string,
  overrides: Partial<TestPayload> = {},
): TestPayload => ({
  id,
  queueOrder: overrides.queueOrder ?? Number(id.replace(/\D/g, '')),
  conversationId: 'conv-1',
  deviceId: 'device-1',
  userPrompt,
  selectedText: null,
  chatContext: null,
  attachments: [],
  optimisticEvent: { _id: id, timestamp: 100 },
  ...overrides,
})

describe('combineQueuedSendPayloads', () => {
  it('returns null when the queue is empty', () => {
    expect(combineQueuedSendPayloads([])).toBeNull()
  })

  it('returns a single queued payload untouched (reference-equal)', () => {
    const only = payload('queued-1', 'hello')
    expect(combineQueuedSendPayloads([only])).toBe(only)
  })

  it('joins queued prompts in order into one turn owned by the first message', () => {
    const combined = combineQueuedSendPayloads([
      payload('queued-1', 'first question'),
      payload('queued-2', 'second question'),
      payload('queued-3', 'third question'),
    ])
    expect(combined?.userPrompt).toBe(
      'first question\n\nsecond question\n\nthird question',
    )
    expect(combined?.id).toBe('queued-1')
    expect(combined?.optimisticEvent._id).toBe('queued-1')
    expect(combined?.conversationId).toBe('conv-1')
    expect(combined?.deviceId).toBe('device-1')
  })

  it('uses captured send order even when async preparation appended out of order', () => {
    const combined = combineQueuedSendPayloads([
      payload('queued-3', 'third question', { queueOrder: 3 }),
      payload('queued-1', 'first question', { queueOrder: 1 }),
      payload('queued-2', 'second question', { queueOrder: 2 }),
    ])
    expect(combined?.userPrompt).toBe(
      'first question\n\nsecond question\n\nthird question',
    )
    expect(combined?.id).toBe('queued-1')
  })

  it('skips empty prompts (attachment-only messages) when joining text', () => {
    const combined = combineQueuedSendPayloads([
      payload('queued-1', '   '),
      payload('queued-2', 'real text'),
    ])
    expect(combined?.userPrompt).toBe('real text')
  })

  it('concatenates attachments in queue order', () => {
    const combined = combineQueuedSendPayloads([
      payload('queued-1', 'a', { attachments: [{ id: 'att-1' }] }),
      payload('queued-2', 'b', {
        attachments: [{ id: 'att-2' }, { id: 'att-3' }],
      }),
    ])
    expect(combined?.attachments).toEqual([
      { id: 'att-1' },
      { id: 'att-2' },
      { id: 'att-3' },
    ])
  })

  it('keeps the most recent non-empty selectedText', () => {
    expect(
      combineQueuedSendPayloads([
        payload('queued-1', 'a', { selectedText: 'old selection' }),
        payload('queued-2', 'b', { selectedText: 'new selection' }),
      ])?.selectedText,
    ).toBe('new selection')
    expect(
      combineQueuedSendPayloads([
        payload('queued-1', 'a', { selectedText: 'kept selection' }),
        payload('queued-2', 'b', { selectedText: null }),
      ])?.selectedText,
    ).toBe('kept selection')
    expect(
      combineQueuedSendPayloads([
        payload('queued-1', 'a'),
        payload('queued-2', 'b'),
      ])?.selectedText,
    ).toBeNull()
  })

  it('merges chat contexts: latest scalar wins, pasted texts concatenate', () => {
    const combined = combineQueuedSendPayloads([
      payload('queued-1', 'a', {
        chatContext: {
          window: { title: 'Doc', app: 'Pages', bounds: { x: 0, y: 0, width: 1, height: 1 } },
          browserUrl: 'https://one.example',
          pastedTexts: ['paste one'],
        },
      }),
      payload('queued-2', 'b', {
        chatContext: {
          window: null,
          pastedTexts: ['paste two'],
        },
      }),
    ])
    expect(combined?.chatContext?.window).toBeNull()
    expect(combined?.chatContext?.browserUrl).toBe('https://one.example')
    expect(combined?.chatContext?.pastedTexts).toEqual([
      'paste one',
      'paste two',
    ])
  })

  it('leaves chatContext null when no queued message captured one', () => {
    expect(
      combineQueuedSendPayloads([
        payload('queued-1', 'a'),
        payload('queued-2', 'b'),
      ])?.chatContext,
    ).toBeNull()
  })

  it('merges message metadata contexts and concatenates pasted-text chips', () => {
    const combined = combineQueuedSendPayloads([
      payload('queued-1', 'a', {
        messageMetadata: {
          context: {
            appSelectionLabel: 'Old selection',
            pastedTexts: [{ text: 'one', lines: 1, chars: 3 }],
          },
        },
      }),
      payload('queued-2', 'b', {
        messageMetadata: {
          context: {
            activityLabel: 'Deep work',
            pastedTexts: [{ text: 'two', lines: 1, chars: 3 }],
          },
        },
      }),
    ])
    expect(combined?.messageMetadata?.context).toEqual({
      appSelectionLabel: 'Old selection',
      activityLabel: 'Deep work',
      pastedTexts: [
        { text: 'one', lines: 1, chars: 3 },
        { text: 'two', lines: 1, chars: 3 },
      ],
    })
  })

  it('omits messageMetadata when no queued message carried any', () => {
    const combined = combineQueuedSendPayloads([
      payload('queued-1', 'a'),
      payload('queued-2', 'b'),
    ])
    expect(combined && 'messageMetadata' in combined && combined.messageMetadata).toBeFalsy()
  })
})

describe('failed queued drain restoration', () => {
  it('restores every drained payload in send order without duplicating ids', () => {
    const first = payload('queued-1', 'first', { queueOrder: 1 })
    const second = payload('queued-2', 'second', { queueOrder: 2 })
    const third = payload('queued-3', 'third', { queueOrder: 3 })

    expect(
      restoreQueuedMessagesAfterFailedDrain(
        [third, second],
        [second, first],
      ),
    ).toEqual([first, second, third])
  })

  it('orders composer rows by monotonic send order, not async completion', () => {
    expect(
      orderQueuedMessages([
        queued('queued-2', 2),
        queued('queued-1', 1),
      ]).map((message) => message.id),
    ).toEqual(['queued-1', 'queued-2'])
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
