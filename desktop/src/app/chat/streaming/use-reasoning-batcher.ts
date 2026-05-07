/**
 * rAF-coalesced reasoning chunks for the local agent stream.
 *
 * Inbound `agent-reasoning` events arrive at sub-frame frequency; this
 * hook accumulates them per `(runId, agentId)` and flushes once per
 * animation frame so the reducer doesn't spin on every keystroke from
 * the underlying SSE.
 */
import { useCallback, useEffect, useRef } from 'react'
import { toRunTaskId, type StreamStoreAction } from './store'

export type PendingReasoningEntry = {
  runId: string
  conversationId: string
  userMessageId?: string
  agentId: string
  chunk: string
}

export function useReasoningBatcher(
  dispatch: (action: StreamStoreAction) => void,
) {
  const pendingReasoningChunksRef = useRef(
    new Map<string, PendingReasoningEntry>(),
  )
  const reasoningFrameRef = useRef<number | null>(null)

  const flushPendingReasoningChunks = useCallback(
    (onlyKey?: string) => {
      const pending = pendingReasoningChunksRef.current
      const entries = onlyKey
        ? pending.has(onlyKey)
          ? [[onlyKey, pending.get(onlyKey)!] as const]
          : []
        : [...pending.entries()]
      if (entries.length === 0) {
        return
      }

      for (const [key] of entries) {
        pending.delete(key)
      }
      for (const [, entry] of entries) {
        dispatch({
          type: 'agent-reasoning',
          runId: entry.runId,
          conversationId: entry.conversationId,
          userMessageId: entry.userMessageId,
          agentId: entry.agentId,
          chunk: entry.chunk,
        })
      }
    },
    [dispatch],
  )

  const queueAgentReasoningChunk = useCallback(
    (entry: PendingReasoningEntry) => {
      const key = toRunTaskId(entry.runId, entry.agentId)
      const current = pendingReasoningChunksRef.current.get(key)
      pendingReasoningChunksRef.current.set(key, {
        ...entry,
        chunk: `${current?.chunk ?? ''}${entry.chunk}`,
      })

      if (reasoningFrameRef.current !== null) {
        return
      }
      reasoningFrameRef.current = window.requestAnimationFrame(() => {
        reasoningFrameRef.current = null
        flushPendingReasoningChunks()
      })
    },
    [flushPendingReasoningChunks],
  )

  const discardPendingReasoningChunks = useCallback(
    (runId: string, agentId: string) => {
      pendingReasoningChunksRef.current.delete(toRunTaskId(runId, agentId))
    },
    [],
  )

  useEffect(() => {
    return () => {
      if (reasoningFrameRef.current !== null) {
        window.cancelAnimationFrame(reasoningFrameRef.current)
        reasoningFrameRef.current = null
      }
      pendingReasoningChunksRef.current.clear()
    }
  }, [])

  return {
    queueAgentReasoningChunk,
    flushPendingReasoningChunks,
    discardPendingReasoningChunks,
  }
}
