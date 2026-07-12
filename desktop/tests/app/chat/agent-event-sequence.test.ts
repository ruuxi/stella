import { describe, expect, it } from 'vitest'
import {
  acceptAgentEventSourceIdentity,
  acceptConversationAgentEventSequence,
} from '@/features/chat/streaming/use-agent-event-handler'
import {
  linkStreamingAssistantCanonicalMessage,
  reconcileStreamingAssistantCanonicalMessage,
  type StreamingAssistantOverlay,
} from '@/features/chat/streaming/streaming-types'

describe('desktop agent event replay deduplication', () => {
  it('deduplicates Date.now-scale main-process sequences', () => {
    const cursors = new Map<string, number>()
    const seq = 1_800_000_000_001

    expect(acceptConversationAgentEventSequence(cursors, 'conv-1', seq)).toBe(true)
    expect(acceptConversationAgentEventSequence(cursors, 'conv-1', seq)).toBe(false)
    expect(acceptConversationAgentEventSequence(cursors, 'conv-1', seq - 1)).toBe(false)
    expect(acceptConversationAgentEventSequence(cursors, 'conv-1', seq + 1)).toBe(true)
  })

  it('keeps sequence cursors independent by conversation', () => {
    const cursors = new Map<string, number>()
    expect(acceptConversationAgentEventSequence(cursors, 'conv-1', 50)).toBe(true)
    expect(acceptConversationAgentEventSequence(cursors, 'conv-2', 1)).toBe(true)
  })

  it('deduplicates the same runtime event across fallback replay and re-sequenced live IPC', () => {
    const seen = new Set<string>()
    expect(
      acceptAgentEventSourceIdentity(seen, {
        type: 'assistant-message',
        runId: 'run-1',
        seq: 12,
      }),
    ).toBe(true)
    expect(
      acceptAgentEventSourceIdentity(seen, {
        type: 'assistant-message',
        runId: 'run-1',
        seq: 1_800_000_000_001,
        sourceSeq: 12,
      }),
    ).toBe(false)
  })
})

describe('assistant optimistic/canonical linkage', () => {
  it('links the current live slot to its exact persisted twin', () => {
    const slot: StreamingAssistantOverlay = {
      _id: 'stream-overlay:u1:2',
      userMessageId: 'u1',
      indexInTurn: 2,
      text: 'answer',
      timestamp: 100,
      runId: 'run-1',
    }
    const source = [slot]
    const linked = linkStreamingAssistantCanonicalMessage(source, {
      userMessageId: 'u1',
      indexInTurn: 2,
      canonicalMessageId: 'assistant-msg-run-1-12',
    })

    expect(linked).not.toBe(source)
    expect(linked[0]).toMatchObject({
      canonicalMessageId: 'assistant-msg-run-1-12',
    })
    expect(slot.canonicalMessageId).toBeUndefined()
  })

  it('replaces a ghost trailing delta with canonical finalized text', () => {
    const source: StreamingAssistantOverlay[] = [{
      _id: 'stream-overlay:u1:1',
      userMessageId: 'u1',
      indexInTurn: 1,
      text: 'Clean answer.\n\ncourt',
      timestamp: 100,
      runId: 'run-1',
    }]
    const reconciled = reconcileStreamingAssistantCanonicalMessage(source, {
      userMessageId: 'u1',
      indexInTurn: 1,
      canonicalMessageId: 'assistant-msg-run-1-14',
      canonicalText: 'Clean answer.',
    })

    expect(reconciled[0]).toMatchObject({
      text: 'Clean answer.',
      locked: true,
      canonicalMessageId: 'assistant-msg-run-1-14',
    })
    expect(source[0]!.text).toBe('Clean answer.\n\ncourt')
  })
})
