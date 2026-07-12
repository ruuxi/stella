/**
 * rAF-coalesced reasoning chunks for the local agent stream.
 *
 * Inbound `agent-reasoning` events arrive at sub-frame frequency; this
 * hook accumulates them per thread (`agentId`) and flushes once per
 * animation frame so the reducer doesn't spin on every keystroke from
 * the underlying SSE.
 */
import { useCallback, useEffect, useRef } from 'react'
import { appendTaskReasoning } from './task-decoration-store'

export type PendingReasoningEntry = {
  agentId: string
  conversationId: string
  runId?: string
  chunk: string
}

export function useReasoningBatcher() {
  const pendingReasoningChunksRef = useRef(
    new Map<string, PendingReasoningEntry>(),
  )
  const reasoningFrameRef = useRef<number | null>(null)

  const flushPendingReasoningChunks = useCallback(
    (onlyAgentId?: string) => {
      const pending = pendingReasoningChunksRef.current
      const entries = onlyAgentId
        ? pending.has(onlyAgentId)
          ? [[onlyAgentId, pending.get(onlyAgentId)!] as const]
          : []
        : [...pending.entries()]
      if (entries.length === 0) {
        return
      }

      for (const [key] of entries) {
        pending.delete(key)
      }
      for (const [, entry] of entries) {
        appendTaskReasoning(entry)
      }
    },
    [],
  )

  const queueAgentReasoningChunk = useCallback(
    (entry: PendingReasoningEntry) => {
      const current = pendingReasoningChunksRef.current.get(entry.agentId)
      pendingReasoningChunksRef.current.set(entry.agentId, {
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

  const discardPendingReasoningChunks = useCallback((agentId: string) => {
    pendingReasoningChunksRef.current.delete(agentId)
  }, [])

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
