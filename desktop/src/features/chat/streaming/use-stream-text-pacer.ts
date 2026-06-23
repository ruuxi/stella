/**
 * Frame-paced reveal of streamed assistant chat text.
 *
 * Provider deltas arrive in bursts (one token, then a 40-char clump, then
 * a stall), so appending each delta 1:1 to the rendered overlay makes the
 * text lurch. This pacer buffers inbound text per overlay slot and
 * releases it on a rAF loop at an adaptive rate: a steady floor while the
 * buffer is small, scaling up so any backlog drains within a fixed number
 * of frames. The buffer can never grow unbounded, so the reveal stays
 * smooth without ever lagging meaningfully behind the model.
 *
 * Mirrors `useReasoningBatcher`'s rAF-coalescing shape, but meters the
 * release instead of flushing everything each frame. `prefers-reduced-
 * motion` bypasses pacing entirely.
 */
import { useCallback, useEffect, useRef } from 'react'

/** Minimum code points released per frame while a buffer is non-empty. */
const MIN_CHARS_PER_FRAME = 2
/** A backlog drains over at most this many frames (~100ms at 60fps). */
const CATCH_UP_FRAMES = 6

type PendingEntry = {
  runId: string
  text: string
}

type StreamSlotPredicate = (entry: {
  slotId: string
  runId: string
}) => boolean

type UseStreamTextPacerOptions = {
  /** Append paced text to the overlay slot's visible text. */
  release: (slotId: string, text: string) => void
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

export function useStreamTextPacer({ release }: UseStreamTextPacerOptions) {
  const pendingRef = useRef(new Map<string, PendingEntry>())
  const frameRef = useRef<number | null>(null)
  // Always invoke the latest `release` without re-creating the rAF loop.
  const releaseRef = useRef(release)
  releaseRef.current = release

  const tick = useCallback(() => {
    frameRef.current = null
    const pending = pendingRef.current
    let scheduleNext = false
    for (const [slotId, entry] of pending) {
      // Split on code points so a surrogate pair is never released
      // half-formed mid-frame.
      const chars = Array.from(entry.text)
      if (chars.length === 0) {
        pending.delete(slotId)
        continue
      }
      const count = Math.max(
        MIN_CHARS_PER_FRAME,
        Math.ceil(chars.length / CATCH_UP_FRAMES),
      )
      const out = chars.slice(0, count).join('')
      const rest = chars.slice(count).join('')
      if (rest) {
        pending.set(slotId, { runId: entry.runId, text: rest })
        scheduleNext = true
      } else {
        pending.delete(slotId)
      }
      releaseRef.current(slotId, out)
    }
    if (scheduleNext) {
      frameRef.current = window.requestAnimationFrame(tick)
    }
  }, [])

  const ensureLoop = useCallback(() => {
    if (frameRef.current === null) {
      frameRef.current = window.requestAnimationFrame(tick)
    }
  }, [tick])

  const cancelLoopIfIdle = useCallback(() => {
    if (pendingRef.current.size === 0 && frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  /** Buffer a chunk for the slot; reduced motion releases it immediately. */
  const enqueue = useCallback(
    (slotId: string, runId: string, chunk: string) => {
      if (!chunk) return
      if (prefersReducedMotion()) {
        releaseRef.current(slotId, chunk)
        return
      }
      const existing = pendingRef.current.get(slotId)
      pendingRef.current.set(slotId, {
        runId,
        text: `${existing?.text ?? ''}${chunk}`,
      })
      ensureLoop()
    },
    [ensureLoop],
  )

  /** Release all buffered text for matching slots immediately. */
  const flush = useCallback(
    (predicate?: StreamSlotPredicate) => {
      const pending = pendingRef.current
      for (const [slotId, entry] of [...pending.entries()]) {
        if (predicate && !predicate({ slotId, runId: entry.runId })) continue
        pending.delete(slotId)
        if (entry.text) releaseRef.current(slotId, entry.text)
      }
      cancelLoopIfIdle()
    },
    [cancelLoopIfIdle],
  )

  /** Drop buffered text for matching slots without releasing it. */
  const discard = useCallback(
    (predicate?: StreamSlotPredicate) => {
      const pending = pendingRef.current
      for (const [slotId, entry] of [...pending.entries()]) {
        if (predicate && !predicate({ slotId, runId: entry.runId })) continue
        pending.delete(slotId)
      }
      cancelLoopIfIdle()
    },
    [cancelLoopIfIdle],
  )

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      pendingRef.current.clear()
    },
    [],
  )

  return { enqueue, flush, discard }
}
