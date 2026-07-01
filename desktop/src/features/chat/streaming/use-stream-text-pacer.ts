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
import {
  createPaceState,
  stepPaceCount,
  type PaceState,
} from './stream-text-pacer-cadence'

/** Assumed frame time for the first frame of a burst (before two timestamps
 *  exist), ~60fps. */
const DEFAULT_FRAME_MS = 16.7

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
  // Per-slot cadence state (smoothed rate + fractional carry), tagged with
  // the owning run. Kept separate from the text buffer so it survives the
  // brief gaps where a slot's buffer empties between provider deltas — the
  // next delta then resumes at the current speed instead of snapping back to
  // the initial rate. The `runId` tag lets flush/discard reclaim it at run
  // boundaries even after the slot's buffer has fully drained.
  const paceStateRef = useRef(
    new Map<string, { runId: string; pace: PaceState }>(),
  )
  const frameRef = useRef<number | null>(null)
  // Timestamp of the previous drained frame, so the cadence integrates the
  // real frame `dt` (frame-rate independent, robust to dropped frames). Reset
  // to `null` whenever the loop goes idle so the gap where nothing was
  // buffered is never counted as elapsed playout time (which would dump on
  // resume).
  const lastTickTimeRef = useRef<number | null>(null)
  // Always invoke the latest `release` without re-creating the rAF loop.
  const releaseRef = useRef(release)
  releaseRef.current = release

  const tick = useCallback(() => {
    frameRef.current = null
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    const last = lastTickTimeRef.current
    const dtMs = last === null ? DEFAULT_FRAME_MS : now - last
    lastTickTimeRef.current = now
    const pending = pendingRef.current
    const paceState = paceStateRef.current
    let scheduleNext = false
    for (const [slotId, entry] of pending) {
      // Split on code points so a surrogate pair is never released
      // half-formed mid-frame.
      const chars = Array.from(entry.text)
      if (chars.length === 0) {
        pending.delete(slotId)
        continue
      }
      let state = paceState.get(slotId)
      if (!state) {
        state = { runId: entry.runId, pace: createPaceState() }
        paceState.set(slotId, state)
      }
      const count = stepPaceCount(state.pace, chars.length, dtMs)
      const out = count > 0 ? chars.slice(0, count).join('') : ''
      const rest = count > 0 ? chars.slice(count).join('') : entry.text
      if (rest) {
        pending.set(slotId, { runId: entry.runId, text: rest })
        scheduleNext = true
      } else {
        // Keep the cadence state warm: the run may stream more text into
        // this same slot after a short gap, and resuming at the current
        // velocity avoids a fresh slow ramp (read: a stutter) on every delta.
        pending.delete(slotId)
      }
      if (out) releaseRef.current(slotId, out)
    }
    if (scheduleNext) {
      frameRef.current = window.requestAnimationFrame(tick)
    } else {
      // Idle: forget the last frame time so the next burst starts a fresh dt
      // (the warm velocity resumes, but the idle gap isn't integrated).
      lastTickTimeRef.current = null
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
      lastTickTimeRef.current = null
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

  /** Drop cadence state for every slot matching `predicate` (also reclaims
   *  slots whose text buffer already drained but stayed warm). */
  const dropPaceState = useCallback((predicate?: StreamSlotPredicate) => {
    for (const [slotId, st] of [...paceStateRef.current.entries()]) {
      if (predicate && !predicate({ slotId, runId: st.runId })) continue
      paceStateRef.current.delete(slotId)
    }
  }, [])

  /** Release all buffered text for matching slots immediately. */
  const flush = useCallback(
    (predicate?: StreamSlotPredicate) => {
      const pending = pendingRef.current
      for (const [slotId, entry] of [...pending.entries()]) {
        if (predicate && !predicate({ slotId, runId: entry.runId })) continue
        pending.delete(slotId)
        if (entry.text) releaseRef.current(slotId, entry.text)
      }
      dropPaceState(predicate)
      cancelLoopIfIdle()
    },
    [cancelLoopIfIdle, dropPaceState],
  )

  /** Drop buffered text for matching slots without releasing it. */
  const discard = useCallback(
    (predicate?: StreamSlotPredicate) => {
      const pending = pendingRef.current
      for (const [slotId, entry] of [...pending.entries()]) {
        if (predicate && !predicate({ slotId, runId: entry.runId })) continue
        pending.delete(slotId)
      }
      dropPaceState(predicate)
      cancelLoopIfIdle()
    },
    [cancelLoopIfIdle, dropPaceState],
  )

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      lastTickTimeRef.current = null
      pendingRef.current.clear()
      paceStateRef.current.clear()
    },
    [],
  )

  return { enqueue, flush, discard }
}
