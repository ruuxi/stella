/**
 * Frame-driven playout for streamed assistant text.
 *
 * Provider deltas are transport units, not useful visual units: one provider
 * may send a character at a time while another sends whole paragraphs. This
 * controller keeps the received text authoritative, then reveals it at a
 * stable display cadence independent of those chunk boundaries.
 */
import { useCallback, useEffect, useRef } from 'react'

export const STREAM_REVEAL_CPS = 72
export const STREAM_CATCH_UP_THRESHOLD = 48
export const STREAM_CATCH_UP_MAX_CPS = 132
export const STREAM_COAST_AFTER_MS = 320
export const STREAM_COAST_RESERVE_MS = 2600
export const STREAM_COAST_MIN_CPS = 48
export const STREAM_FINISH_MIN_CPS = 110
export const STREAM_FINISH_MAX_CPS = 180
export const STREAM_FINISH_TARGET_MS = 2400
export const STREAM_FINISH_FALLBACK_MS = 30000
export const STREAM_MAX_FRAME_MS = 50
export const STREAM_MIN_RENDER_INTERVAL_MS = 30

const DEFAULT_FRAME_MS = 1000 / 60
const BUFFER_COMPACT_THRESHOLD = 4096
const INITIAL_REVEAL_CREDIT = 0.5

export type StreamTextAnimationEntry = {
  slotId: string
  runId: string
}

type StreamTextAnimationPredicate = (entry: StreamTextAnimationEntry) => boolean

export type StreamTextAnimationScheduler = {
  now: () => number
  requestFrame: (callback: (nowMs: number) => void) => number
  cancelFrame: (frameId: number) => void
  setTimer: (callback: () => void, delayMs: number) => number
  clearTimer: (timerId: number) => void
}

type AnimationEntry = {
  runId: string
  chars: string[]
  cursor: number
  visibleText: string
  carry: number
  trailingHighSurrogate: string
  finishing: boolean
  finishTimer: number | null
  onDrained: Set<(slotId: string) => void>
  lastArrivalAtMs: number | null
  lastRevealAtMs: number | null
}

export type StreamTextAnimationControllerOptions = {
  scheduler: StreamTextAnimationScheduler
  onReveal: (slotId: string, visibleText: string) => void
}

const isHighSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xd800 && codeUnit <= 0xdbff

/**
 * Return a bounded display velocity. A growing backlog ramps toward the
 * catch-up ceiling, while a provider gap gradually spends the remaining
 * buffer over a reserve window instead of racing to empty and visibly
 * stalling. The coast floor prevents a dramatic slow-motion tail.
 */
export function streamRevealRate(
  backlog: number,
  timeSinceArrivalMs = 0,
): number {
  const depthRamp = Math.min(
    1,
    Math.max(0, backlog - STREAM_CATCH_UP_THRESHOLD) /
      (STREAM_CATCH_UP_THRESHOLD * 6),
  )
  const rate =
    STREAM_REVEAL_CPS +
    (STREAM_CATCH_UP_MAX_CPS - STREAM_REVEAL_CPS) * depthRamp
  if (timeSinceArrivalMs <= STREAM_COAST_AFTER_MS) return rate
  const coastRate = Math.min(
    STREAM_CATCH_UP_MAX_CPS,
    Math.max(
      STREAM_COAST_MIN_CPS,
      (backlog * 1000) / STREAM_COAST_RESERVE_MS,
    ),
  )
  return Math.min(rate, coastRate)
}

/** Pure cadence step, exported so timing guarantees can be tested directly. */
export function stepStreamReveal(args: {
  backlog: number
  carry: number
  elapsedMs: number
  finishing: boolean
  timeSinceArrivalMs?: number
}): { count: number; carry: number } {
  if (args.backlog <= 0) return { count: 0, carry: args.carry }

  const elapsedMs = Math.min(Math.max(args.elapsedMs, 1), STREAM_MAX_FRAME_MS)
  const normalCps = streamRevealRate(args.backlog, args.timeSinceArrivalMs)
  const finishCps = Math.min(
    STREAM_FINISH_MAX_CPS,
    Math.max(
      STREAM_FINISH_MIN_CPS,
      (args.backlog * 1000) / STREAM_FINISH_TARGET_MS,
    ),
  )
  const cps = args.finishing ? Math.max(normalCps, finishCps) : normalCps
  let carry = args.carry + (cps * elapsedMs) / 1000
  const count = Math.min(args.backlog, Math.floor(carry))
  carry -= count
  return { count, carry }
}

/**
 * Stateful, React-independent animation engine. It deliberately emits the
 * full visible value rather than append deltas, making renderer updates
 * idempotent and preventing stale React closures from duplicating text.
 */
export class StreamTextAnimationController {
  private readonly scheduler: StreamTextAnimationScheduler
  private onReveal: (slotId: string, visibleText: string) => void
  private readonly entries = new Map<string, AnimationEntry>()
  private frameId: number | null = null
  private disposed = false

  constructor(options: StreamTextAnimationControllerOptions) {
    this.scheduler = options.scheduler
    this.onReveal = options.onReveal
  }

  setOnReveal(onReveal: (slotId: string, visibleText: string) => void): void {
    this.onReveal = onReveal
  }

  enqueue(slotId: string, runId: string, chunk: string): void {
    if (this.disposed || !chunk) return
    let entry = this.entries.get(slotId)
    if (!entry) {
      entry = {
        runId,
        chars: [],
        cursor: 0,
        visibleText: '',
        carry: INITIAL_REVEAL_CREDIT,
        trailingHighSurrogate: '',
        finishing: false,
        finishTimer: null,
        onDrained: new Set(),
        lastArrivalAtMs: null,
        lastRevealAtMs: null,
      }
      this.entries.set(slotId, entry)
    }
    if (entry.finishing) {
      this.clearFinishTimer(entry)
      entry.onDrained.clear()
      entry.finishing = false
    }

    const nowMs = this.scheduler.now()
    const wasEmpty = this.remaining(entry) === 0 && !entry.trailingHighSurrogate
    const combined = `${entry.trailingHighSurrogate}${chunk}`
    entry.trailingHighSurrogate = ''
    let safeText = combined
    if (
      safeText.length > 0 &&
      isHighSurrogate(safeText.charCodeAt(safeText.length - 1))
    ) {
      entry.trailingHighSurrogate = safeText.at(-1) ?? ''
      safeText = safeText.slice(0, -1)
    }
    for (const char of safeText) entry.chars.push(char)
    if (wasEmpty && (safeText || entry.trailingHighSurrogate)) {
      entry.lastRevealAtMs = null
    }
    entry.lastArrivalAtMs = nowMs
    this.ensureFrame()
  }

  /** Immediately reveal matching buffers. Used for reduced motion only. */
  flush(predicate?: StreamTextAnimationPredicate): void {
    for (const [slotId, entry] of [...this.entries]) {
      if (predicate && !predicate({ slotId, runId: entry.runId })) continue
      this.flushEntry(slotId, entry)
    }
    this.cancelFrameIfIdle()
  }

  /**
   * Mark matching slots terminal and drain them at the fast completion pace.
   * A timeout guarantees cleanup if rAF is suspended in a hidden window.
   */
  finish(
    predicate: StreamTextAnimationPredicate | undefined,
    onDrained: (slotId: string) => void,
  ): void {
    for (const [slotId, entry] of [...this.entries]) {
      if (predicate && !predicate({ slotId, runId: entry.runId })) continue
      entry.onDrained.add(onDrained)
      entry.finishing = true
      if (entry.trailingHighSurrogate) {
        entry.chars.push(entry.trailingHighSurrogate)
        entry.trailingHighSurrogate = ''
      }

      if (this.remaining(entry) === 0) {
        this.completeEntry(slotId, entry)
        continue
      }
      if (entry.finishTimer === null) {
        entry.finishTimer = this.scheduler.setTimer(() => {
          const current = this.entries.get(slotId)
          if (current !== entry) return
          this.flushEntry(slotId, entry)
          this.cancelFrameIfIdle()
        }, STREAM_FINISH_FALLBACK_MS)
      }
    }
    this.ensureFrame()
  }

  discard(predicate?: StreamTextAnimationPredicate): void {
    for (const [slotId, entry] of [...this.entries]) {
      if (predicate && !predicate({ slotId, runId: entry.runId })) continue
      this.clearFinishTimer(entry)
      this.entries.delete(slotId)
    }
    this.cancelFrameIfIdle()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameId !== null) this.scheduler.cancelFrame(this.frameId)
    this.frameId = null
    for (const entry of this.entries.values()) this.clearFinishTimer(entry)
    this.entries.clear()
  }

  private readonly tick = (nowMs: number): void => {
    this.frameId = null
    if (this.disposed) return
    let hasBufferedText = false

    for (const [slotId, entry] of [...this.entries]) {
      const backlog = this.remaining(entry)
      if (backlog <= 0) continue
      const elapsedSinceReveal =
        entry.lastRevealAtMs === null
          ? DEFAULT_FRAME_MS
          : nowMs - entry.lastRevealAtMs
      if (
        entry.lastRevealAtMs !== null &&
        elapsedSinceReveal < STREAM_MIN_RENDER_INTERVAL_MS
      ) {
        hasBufferedText = true
        continue
      }
      entry.lastRevealAtMs = nowMs
      const step = stepStreamReveal({
        backlog,
        carry: entry.carry,
        elapsedMs: elapsedSinceReveal,
        finishing: entry.finishing,
        timeSinceArrivalMs: Math.max(
          0,
          nowMs - (entry.lastArrivalAtMs ?? nowMs),
        ),
      })
      entry.carry = step.carry
      if (step.count > 0) {
        const text = entry.chars
          .slice(entry.cursor, entry.cursor + step.count)
          .join('')
        entry.cursor += step.count
        entry.visibleText += text
        this.onReveal(slotId, entry.visibleText)
        this.compact(entry)
      }

      if (this.remaining(entry) > 0) {
        hasBufferedText = true
      } else if (entry.finishing) {
        this.completeEntry(slotId, entry)
      } else {
        entry.lastRevealAtMs = null
      }
    }

    if (hasBufferedText) {
      this.frameId = this.scheduler.requestFrame(this.tick)
    }
  }

  private ensureFrame(): void {
    if (this.disposed || this.frameId !== null) return
    const hasBufferedText = [...this.entries.values()].some(
      (entry) => this.remaining(entry) > 0,
    )
    if (!hasBufferedText) return
    this.frameId = this.scheduler.requestFrame(this.tick)
  }

  private cancelFrameIfIdle(): void {
    const hasBufferedText = [...this.entries.values()].some(
      (entry) => this.remaining(entry) > 0,
    )
    if (hasBufferedText || this.frameId === null) return
    this.scheduler.cancelFrame(this.frameId)
    this.frameId = null
  }

  private remaining(entry: AnimationEntry): number {
    return entry.chars.length - entry.cursor
  }

  private compact(entry: AnimationEntry): void {
    if (entry.cursor < BUFFER_COMPACT_THRESHOLD) return
    entry.chars.splice(0, entry.cursor)
    entry.cursor = 0
  }

  private flushEntry(slotId: string, entry: AnimationEntry): void {
    const tail = entry.chars.slice(entry.cursor).join('')
    entry.cursor = entry.chars.length
    entry.visibleText += `${tail}${entry.trailingHighSurrogate}`
    entry.trailingHighSurrogate = ''
    entry.lastRevealAtMs = null
    this.onReveal(slotId, entry.visibleText)
    if (entry.finishing) this.completeEntry(slotId, entry)
  }

  private completeEntry(slotId: string, entry: AnimationEntry): void {
    this.clearFinishTimer(entry)
    for (const callback of entry.onDrained) callback(slotId)
    entry.onDrained.clear()
    entry.chars = []
    entry.cursor = 0
    entry.carry = 0
    entry.finishing = false
    entry.lastArrivalAtMs = null
    entry.lastRevealAtMs = null
  }

  private clearFinishTimer(entry: AnimationEntry): void {
    if (entry.finishTimer === null) return
    this.scheduler.clearTimer(entry.finishTimer)
    entry.finishTimer = null
  }
}

const browserScheduler: StreamTextAnimationScheduler = {
  now: () => performance.now(),
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (frameId) => window.cancelAnimationFrame(frameId),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (timerId) => window.clearTimeout(timerId),
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

export function useStreamTextAnimation(options: {
  onReveal: (slotId: string, visibleText: string) => void
}) {
  const onRevealRef = useRef(options.onReveal)
  onRevealRef.current = options.onReveal
  const controllerRef = useRef<StreamTextAnimationController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = new StreamTextAnimationController({
      scheduler: browserScheduler,
      onReveal: (slotId, visibleText) =>
        onRevealRef.current(slotId, visibleText),
    })
  }

  const enqueue = useCallback(
    (slotId: string, runId: string, chunk: string) => {
      const controller = controllerRef.current
      if (!controller) return
      controller.enqueue(slotId, runId, chunk)
      if (prefersReducedMotion()) {
        controller.flush((entry) => entry.slotId === slotId)
      }
    },
    [],
  )

  const finish = useCallback(
    (
      predicate: StreamTextAnimationPredicate | undefined,
      onDrained: (slotId: string) => void,
    ) => controllerRef.current?.finish(predicate, onDrained),
    [],
  )

  const discard = useCallback(
    (predicate?: StreamTextAnimationPredicate) =>
      controllerRef.current?.discard(predicate),
    [],
  )

  useEffect(
    () => () => {
      controllerRef.current?.dispose()
      controllerRef.current = null
    },
    [],
  )

  return { enqueue, finish, discard }
}
