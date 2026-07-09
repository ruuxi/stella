#!/usr/bin/env bun
import {
  StreamTextAnimationController,
  type StreamTextAnimationScheduler,
} from '../src/features/chat/streaming/use-stream-text-animation'
import {
  ALL_STREAM_CADENCE_TRACES,
  type StreamCadenceTrace,
} from '../tests/fixtures/stream-cadence-traces'

const FRAME_MS = 1000 / 60

type ScheduledCallback = {
  dueAtMs: number
  callback: () => void
}

class VirtualScheduler implements StreamTextAnimationScheduler {
  nowMs = 0
  private nextId = 1
  private readonly frames = new Map<number, ScheduledCallback>()
  private readonly timers = new Map<number, ScheduledCallback>()

  now = () => this.nowMs

  requestFrame = (callback: (nowMs: number) => void): number => {
    const id = this.nextId++
    this.frames.set(id, {
      dueAtMs: this.nowMs + FRAME_MS,
      callback: () => callback(this.nowMs),
    })
    return id
  }

  cancelFrame = (frameId: number): void => {
    this.frames.delete(frameId)
  }

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++
    this.timers.set(id, { dueAtMs: this.nowMs + delayMs, callback })
    return id
  }

  clearTimer = (timerId: number): void => {
    this.timers.delete(timerId)
  }

  nextDueAtMs(): number {
    let next = Number.POSITIVE_INFINITY
    for (const item of this.frames.values()) next = Math.min(next, item.dueAtMs)
    for (const item of this.timers.values()) next = Math.min(next, item.dueAtMs)
    return next
  }

  runAt(nowMs: number): void {
    this.nowMs = nowMs
    this.runDue(this.timers)
    this.runDue(this.frames)
  }

  private runDue(items: Map<number, ScheduledCallback>): void {
    for (const [id, item] of [...items]) {
      if (item.dueAtMs > this.nowMs + 0.001) continue
      items.delete(id)
      item.callback()
    }
  }
}

type DisplayUpdate = { atMs: number; chars: number }

type CadenceMetrics = {
  initialLatencyMs: number
  charIntervalStdMs: number
  wordIntervalStdMs: number
  maxPresentationLagMs: number
  completionDrainMs: number
  renderCount: number
  renderHz: number
  maxCharsPerRender: number
}

const standardDeviation = (values: readonly number[]): number => {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length
  return Math.sqrt(variance)
}

const expandTimes = (updates: readonly DisplayUpdate[]): number[] =>
  updates.flatMap((update) => Array(update.chars).fill(update.atMs) as number[])

const intervals = (times: readonly number[], stride = 1): number[] => {
  const result: number[] = []
  for (let index = stride; index < times.length; index += stride) {
    result.push(times[index]! - times[index - stride]!)
  }
  return result
}

const measure = (
  trace: StreamCadenceTrace,
  updates: readonly DisplayUpdate[],
): CadenceMetrics => {
  const receivedTimes = expandTimes(
    trace.arrivals.map(([atMs, chars]) => ({ atMs, chars })),
  )
  const visibleTimes = expandTimes(updates)
  if (receivedTimes.length !== visibleTimes.length) {
    throw new Error(
      `${trace.name}: received ${receivedTimes.length}, displayed ${visibleTimes.length}`,
    )
  }
  const firstArrival = receivedTimes[0] ?? 0
  const firstVisible = visibleTimes[0] ?? firstArrival
  const lastVisible = visibleTimes.at(-1) ?? trace.completeAtMs
  const durationMs = Math.max(lastVisible - firstArrival, 1)
  return {
    initialLatencyMs: firstVisible - firstArrival,
    charIntervalStdMs: standardDeviation(intervals(visibleTimes)),
    // Six characters approximates one English word plus its following space.
    wordIntervalStdMs: standardDeviation(intervals(visibleTimes, 6)),
    maxPresentationLagMs: Math.max(
      0,
      ...visibleTimes.map((atMs, index) => atMs - receivedTimes[index]!),
    ),
    completionDrainMs: Math.max(0, lastVisible - trace.completeAtMs),
    renderCount: updates.length,
    renderHz: (updates.length * 1000) / durationMs,
    maxCharsPerRender: Math.max(0, ...updates.map((update) => update.chars)),
  }
}

const simulateImmediate = (trace: StreamCadenceTrace): CadenceMetrics =>
  measure(
    trace,
    trace.arrivals.map(([atMs, chars]) => ({ atMs, chars })),
  )

const simulateAnimated = (trace: StreamCadenceTrace): CadenceMetrics => {
  const scheduler = new VirtualScheduler()
  const updates: DisplayUpdate[] = []
  let previousLength = 0
  const controller = new StreamTextAnimationController({
    scheduler,
    onReveal: (_slotId, text) => {
      updates.push({
        atMs: scheduler.nowMs,
        chars: text.length - previousLength,
      })
      previousLength = text.length
    },
  })

  let arrivalIndex = 0
  let finished = false
  while (true) {
    const nextArrival = trace.arrivals[arrivalIndex]?.[0]
    const nextFinish = finished ? Number.POSITIVE_INFINITY : trace.completeAtMs
    const nextScheduled = scheduler.nextDueAtMs()
    const nextAt = Math.min(
      nextArrival ?? Number.POSITIVE_INFINITY,
      nextFinish,
      nextScheduled,
    )
    if (!Number.isFinite(nextAt)) break
    scheduler.nowMs = nextAt
    while (
      arrivalIndex < trace.arrivals.length &&
      trace.arrivals[arrivalIndex]![0] <= nextAt + 0.001
    ) {
      const [, chars] = trace.arrivals[arrivalIndex]!
      controller.enqueue('slot', 'run', 'x'.repeat(chars))
      arrivalIndex += 1
    }
    if (!finished && trace.completeAtMs <= nextAt + 0.001) {
      finished = true
      controller.finish((entry) => entry.runId === 'run', () => {})
    }
    scheduler.runAt(nextAt)
  }

  controller.dispose()
  return measure(trace, updates)
}

const fixed = (value: number): string => value.toFixed(1)

console.log(
  [
    'trace',
    'mode',
    'initial_ms',
    'char_std_ms',
    'word_std_ms',
    'max_lag_ms',
    'drain_ms',
    'renders',
    'render_hz',
    'max_step',
  ].join('\t'),
)

for (const trace of ALL_STREAM_CADENCE_TRACES) {
  for (const [mode, metrics] of [
    ['before', simulateImmediate(trace)],
    ['after', simulateAnimated(trace)],
  ] as const) {
    console.log(
      [
        trace.name,
        mode,
        fixed(metrics.initialLatencyMs),
        fixed(metrics.charIntervalStdMs),
        fixed(metrics.wordIntervalStdMs),
        fixed(metrics.maxPresentationLagMs),
        fixed(metrics.completionDrainMs),
        metrics.renderCount,
        fixed(metrics.renderHz),
        metrics.maxCharsPerRender,
      ].join('\t'),
    )
  }
}
