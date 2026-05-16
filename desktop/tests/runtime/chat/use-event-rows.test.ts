import { describe, expect, it } from 'vitest'
import { segmentToolEventsByAssistant } from '@/app/chat/use-event-rows'
import type { EventRecord } from '@/app/chat/lib/event-transforms'

const event = (overrides: Partial<EventRecord>): EventRecord => ({
  _id: overrides._id ?? 'event',
  timestamp: overrides.timestamp ?? 1,
  type: overrides.type ?? 'tool_result',
  ...(overrides.requestId ? { requestId: overrides.requestId } : {}),
  ...(overrides.payload ? { payload: overrides.payload } : {}),
})

describe('segmentToolEventsByAssistant', () => {
  it('keeps final tool events as a trailing segment when no assistant row follows', () => {
    const segmented = segmentToolEventsByAssistant([
      event({
        _id: 'user-1',
        type: 'user_message',
        payload: { text: 'make an image' },
      }),
      event({
        _id: 'tool-start-1',
        type: 'tool_request',
        requestId: 'call-1',
        payload: {
          toolName: 'image_gen',
          agentType: 'orchestrator',
          args: { prompt: 'a product mockup' },
        },
      }),
      event({
        _id: 'tool-end-1',
        type: 'tool_result',
        requestId: 'call-1',
        payload: {
          toolName: 'image_gen',
          agentType: 'orchestrator',
          result: {
            jobId: 'job-1',
            capability: 'text_to_image',
            prompt: 'a product mockup',
            status: 'submitted',
          },
        },
      }),
    ])

    expect(segmented.byAssistantId.size).toBe(0)
    expect(segmented.trailing.map((entry) => entry._id)).toEqual([
      'tool-start-1',
      'tool-end-1',
    ])
  })

  it('attaches tool events to the next assistant row when one exists', () => {
    const segmented = segmentToolEventsByAssistant([
      event({
        _id: 'tool-end-1',
        type: 'tool_result',
        requestId: 'call-1',
        payload: { toolName: 'image_gen' },
      }),
      event({
        _id: 'assistant-1',
        type: 'assistant_message',
        payload: { text: 'Generated it.' },
      }),
    ])

    expect(
      segmented.byAssistantId.get('assistant-1')?.map((entry) => entry._id),
    ).toEqual(['tool-end-1'])
    expect(segmented.trailing).toEqual([])
  })

  it('attaches tool events that land AFTER the assistant to that same turn', () => {
    // Repros the inline canvas bug: orchestrator streams its reply text,
    // assistant_message persists, THEN the `html` tool finalizes and
    // appends its tool_result. Without turn-aware grouping the tool would
    // be stuck in `trailing` until a new user_message rebuilt segmentation.
    const segmented = segmentToolEventsByAssistant([
      event({
        _id: 'user-1',
        type: 'user_message',
        payload: { text: 'plan something' },
      }),
      event({
        _id: 'assistant-1',
        type: 'assistant_message',
        payload: { text: 'Here is the plan.' },
      }),
      event({
        _id: 'tool-req-1',
        type: 'tool_request',
        requestId: 'call-1',
        payload: { toolName: 'html', agentType: 'orchestrator' },
      }),
      event({
        _id: 'tool-end-1',
        type: 'tool_result',
        requestId: 'call-1',
        payload: {
          toolName: 'html',
          agentType: 'orchestrator',
          details: {
            filePath: '/state/outputs/html/plan.html',
            slug: 'plan',
            title: 'Plan',
            createdAt: 1,
          },
        },
      }),
    ])

    expect(
      segmented.byAssistantId.get('assistant-1')?.map((entry) => entry._id),
    ).toEqual(['tool-req-1', 'tool-end-1'])
    expect(segmented.trailing).toEqual([])
  })

  it('keeps secondary assistants in the same turn (agent terminal notices) addressable', () => {
    const segmented = segmentToolEventsByAssistant([
      event({
        _id: 'user-1',
        type: 'user_message',
        payload: { text: 'run agent' },
      }),
      event({
        _id: 'assistant-1',
        type: 'assistant_message',
        payload: { text: 'Working on it.' },
      }),
      event({
        _id: 'tool-end-1',
        type: 'tool_result',
        requestId: 'call-1',
        payload: { toolName: 'spawn_agent', agentType: 'orchestrator' },
      }),
      event({
        _id: 'assistant-2',
        type: 'assistant_message',
        payload: { text: 'Agent completed.' },
      }),
    ])

    expect(
      segmented.byAssistantId.get('assistant-1')?.map((entry) => entry._id),
    ).toEqual(['tool-end-1'])
    expect(segmented.byAssistantId.get('assistant-2')).toEqual([])
    expect(segmented.trailing).toEqual([])
  })
})
