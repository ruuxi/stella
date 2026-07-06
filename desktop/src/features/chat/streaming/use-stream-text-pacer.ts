/**
 * Frame-paced reveal of streamed assistant chat text.
 *
 * Provider deltas arrive in bursts (one token, then a 40-char clump, then
 * a stall), so appending each delta 1:1 to the rendered overlay makes the
 * text lurch. This pacer buffers inbound text per overlay slot and
 * releases it on a rAF loop through a jitter-buffer cadence: a startup
 * cushion is banked before the first character reveals, then playout runs
 * at a slew-limited velocity tracking the smoothed arrival rate — one
 * continuous pour that never mirrors arrival chop (see
 * stream-text-pacer-cadence.ts). Every inbound chunk is recorded into the
 * slot's cadence state (`recordArrival`) to feed those estimates.
 *
 * `finish` is the graceful counterpart to `flush` for stream end: instead
 * of dumping the backlog synchronously, it switches matching slots to a
 * fast drain (~FINISH_LATENCY_MS) and invokes a callback once each slot's
 * buffered text has fully landed, backed by a hard-flush safety timeout in
 * case rAF is throttled (hidden window).
 *
 * Mirrors `useReasoningBatcher`'s rAF-coalescing shape, but meters the
 * release instead of flushing everything each frame. `prefers-reduced-
 * motion` bypasses pacing entirely.
 */
import { useCallback, useEffect, useRef } from 'react'
import {
  createPaceState,
  recordArrival,
  stepPaceCount,
  type PaceState,
} from './stream-text-pacer-cadence'

/** Assumed frame time for the first frame of a burst (before two timestamps
 *  exist), ~60fps. */
const DEFAULT_FRAME_MS = 16.7

/** Hard-flush fallback if a finishing slot's rAF drain can't run (hidden
 *  window throttles rAF); comfortably beyond FINISH_LATENCY_MS. The timer
 *  is progress-aware: while the drain is visibly shrinking the buffer it
 *  re-arms instead of flushing, so a large backlog's rate-capped finish
 *  glide (FINISH_MAX_CPS) is never cut short — only a genuinely stalled
 *  drain dumps. */
const FINISH_FALLBACK_MS = 1200

/** Once the release cursor has passed this many consumed code points, splice
 *  the drained prefix off the buffer and reset the cursor. Keeps the common
 *  per-frame release allocation-free (a bounded slice) while stopping a long
 *  stream from retaining every already-shown code point for the slot's life. */
const BUFFER_COMPACT_THRESHOLD = 4096

type PendingEntry = {
  runId: string
  /** Buffered text as code points; splitting on enqueue (not per frame) keeps
   *  a surrogate pair from ever releasing half-formed and makes each frame's
   *  release O(released) instead of O(backlog). */
  chars: string[]
  /** Index of the next unreleased code point in `chars`. */
  cursor: number
  /** Stream ended for this slot — drain fast and report when empty. */
  finishing?: boolean
  /** Invoked once the slot's buffered text has fully released. */
  onDrained?: (slotId: string) => void
  /** Safety hard-flush timer armed while `finishing`. */
  finishTimer?: number
  /** Remaining code-point count when `finishTimer` was (re)armed — progress
   *  check. */
  finishTimerRemaining?: number
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
      // The buffer is already split on code points (at enqueue), so a
      // surrogate pair is never released half-formed. `cursor` marks the
      // boundary between released and pending; work only the pending tail.
      const remaining = entry.chars.length - entry.cursor
      if (remaining === 0) {
        pending.delete(slotId)
        continue
      }
      let state = paceState.get(slotId)
      if (!state) {
        state = { runId: entry.runId, pace: createPaceState() }
        paceState.set(slotId, state)
      }
      const count = stepPaceCount(
        state.pace,
        remaining,
        dtMs,
        entry.finishing === true,
      )
      const releaseCount = count > 0 ? Math.min(count, remaining) : 0
      const out =
        releaseCount > 0
          ? entry.chars.slice(entry.cursor, entry.cursor + releaseCount).join('')
          : ''
      entry.cursor += releaseCount
      const rest = entry.chars.length - entry.cursor
      if (rest > 0) {
        // Drop the consumed prefix once it grows large so the slot doesn't
        // retain every already-released code point for its whole lifetime.
        if (entry.cursor > BUFFER_COMPACT_THRESHOLD) {
          entry.chars.splice(0, entry.cursor)
          entry.cursor = 0
        }
        scheduleNext = true
      } else {
        // Keep the cadence state warm: the run may stream more text into
        // this same slot after a short gap, and resuming at the current
        // velocity avoids a fresh slow ramp (read: a stutter) on every delta.
        pending.delete(slotId)
      }
      if (out) releaseRef.current(slotId, out)
      if (rest === 0 && entry.finishing) {
        // Finishing slot fully drained: reclaim its cadence state (no more
        // text is coming for this slot) and report AFTER the final release
        // so the callback observes the complete text.
        if (entry.finishTimer !== undefined) {
          window.clearTimeout(entry.finishTimer)
        }
        paceState.delete(slotId)
        entry.onDrained?.(slotId)
      }
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
      if (existing) {
        // Append the chunk's code points (iterating a string yields code
        // points) so the buffer stays surrogate-safe without re-splitting.
        for (const ch of chunk) existing.chars.push(ch)
      } else {
        pendingRef.current.set(slotId, {
          runId,
          chars: Array.from(chunk),
          cursor: 0,
        })
      }
      // Feed the slot's arrival-rate/gap estimators so the cadence adapts
      // to slow or choppy providers (created here, ahead of the first tick,
      // so the very first frame already sees arrival data).
      let state = paceStateRef.current.get(slotId)
      if (!state) {
        state = { runId, pace: createPaceState() }
        paceStateRef.current.set(slotId, state)
      }
      recordArrival(
        state.pace,
        Array.from(chunk).length,
        typeof performance !== 'undefined' ? performance.now() : Date.now(),
      )
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
        if (entry.finishTimer !== undefined) {
          window.clearTimeout(entry.finishTimer)
        }
        if (entry.cursor < entry.chars.length) {
          releaseRef.current(slotId, entry.chars.slice(entry.cursor).join(''))
        }
        // A hard flush overtaking a graceful finish still owes the caller
        // its drained notification (e.g. the slot lock).
        entry.onDrained?.(slotId)
      }
      dropPaceState(predicate)
      cancelLoopIfIdle()
    },
    [cancelLoopIfIdle, dropPaceState],
  )

  /**
   * Gracefully end the stream for matching slots: keep draining each slot's
   * buffered text but at the fast finish pace, then invoke `onDrained` once
   * the slot's text has fully released (a safety timeout hard-flushes if rAF
   * is throttled). Returns whether any matching slot is still draining —
   * `false` means nothing was buffered and the caller should run its
   * post-drain work synchronously.
   */
  const finish = useCallback(
    (
      predicate: StreamSlotPredicate | undefined,
      onDrained: (slotId: string) => void,
    ): boolean => {
      let draining = false
      for (const [slotId, entry] of pendingRef.current) {
        if (predicate && !predicate({ slotId, runId: entry.runId })) continue
        if (entry.cursor >= entry.chars.length) continue
        draining = true
        entry.finishing = true
        entry.onDrained = onDrained
        if (entry.finishTimer !== undefined) {
          window.clearTimeout(entry.finishTimer)
        }
        const armFallback = () => {
          entry.finishTimerRemaining = entry.chars.length - entry.cursor
          entry.finishTimer = window.setTimeout(() => {
            const current = pendingRef.current.get(slotId)
            if (current !== entry) return
            const currentRemaining = current.chars.length - current.cursor
            // The paced drain is making progress (rAF is running): a large
            // backlog legitimately outlasts the timeout at the bounded
            // finish rate — keep gliding, re-check later.
            if (
              currentRemaining <
              (current.finishTimerRemaining ?? Number.POSITIVE_INFINITY)
            ) {
              armFallback()
              return
            }
            pendingRef.current.delete(slotId)
            paceStateRef.current.delete(slotId)
            if (currentRemaining > 0) {
              releaseRef.current(
                slotId,
                current.chars.slice(current.cursor).join(''),
              )
            }
            cancelLoopIfIdle()
            current.onDrained?.(slotId)
          }, FINISH_FALLBACK_MS)
        }
        armFallback()
        ensureLoop()
      }
      return draining
    },
    [cancelLoopIfIdle, ensureLoop],
  )

  /** Drop buffered text for matching slots without releasing it. */
  const discard = useCallback(
    (predicate?: StreamSlotPredicate) => {
      const pending = pendingRef.current
      for (const [slotId, entry] of [...pending.entries()]) {
        if (predicate && !predicate({ slotId, runId: entry.runId })) continue
        pending.delete(slotId)
        if (entry.finishTimer !== undefined) {
          window.clearTimeout(entry.finishTimer)
        }
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
      for (const entry of pendingRef.current.values()) {
        if (entry.finishTimer !== undefined) {
          window.clearTimeout(entry.finishTimer)
        }
      }
      pendingRef.current.clear()
      paceStateRef.current.clear()
    },
    [],
  )

  return { enqueue, flush, finish, discard }
}
