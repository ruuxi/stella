import { describe, expect, it } from 'vitest'
import {
  STREAM_CATCH_UP_MAX_CPS,
  STREAM_FINISH_FALLBACK_MS,
  STREAM_FINISH_MAX_CPS,
  STREAM_MAX_FRAME_MS,
  STREAM_REVEAL_CPS,
  StreamTextAnimationController,
  type StreamTextAnimationScheduler,
} from '@/features/chat/streaming/use-stream-text-animation'
import { CLAUDE_CODE_CAPTURED_TRACE } from '../../fixtures/stream-cadence-traces'

class FakeScheduler implements StreamTextAnimationScheduler {
  time = 0
  private nextId = 1
  readonly frames = new Map<number, (nowMs: number) => void>()
  readonly timers = new Map<number, { callback: () => void; dueAtMs: number }>()

  now = () => this.time

  requestFrame = (callback: (nowMs: number) => void): number => {
    const id = this.nextId++
    this.frames.set(id, callback)
    return id
  }

  cancelFrame = (frameId: number): void => {
    this.frames.delete(frameId)
  }

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++
    this.timers.set(id, { callback, dueAtMs: this.time + delayMs })
    return id
  }

  clearTimer = (timerId: number): void => {
    this.timers.delete(timerId)
  }

  advance(ms = 1000 / 60): void {
    this.time += ms
    this.runDueTimers()
    const callbacks = [...this.frames.values()]
    this.frames.clear()
    for (const callback of callbacks) callback(this.time)
    this.runDueTimers()
  }

  pause(ms: number): void {
    this.time += ms
    this.runDueTimers()
  }

  runFrames(count: number, ms = 1000 / 60): void {
    for (let index = 0; index < count; index += 1) this.advance(ms)
  }

  runUntilNoFrames(maxFrames = 10_000, ms = 1000 / 60): void {
    let frame = 0
    while (this.frames.size > 0 && frame < maxFrames) {
      this.advance(ms)
      frame += 1
    }
    expect(frame).toBeLessThan(maxFrames)
  }

  private runDueTimers(): void {
    for (const [id, timer] of [...this.timers]) {
      if (timer.dueAtMs > this.time) continue
      this.timers.delete(id)
      timer.callback()
    }
  }
}

const createScene = () => {
  const scheduler = new FakeScheduler()
  const updates: Array<{ slotId: string; text: string; atMs: number }> = []
  const controller = new StreamTextAnimationController({
    scheduler,
    onReveal: (slotId, text) =>
      updates.push({ slotId, text, atMs: scheduler.time }),
  })
  return { scheduler, updates, controller }
}

describe('StreamTextAnimationController', () => {
  it('turns one burst into a steady 30-45 cps visual stream', () => {
    const { controller, scheduler, updates } = createScene()
    const text = 'x'.repeat(30)
    controller.enqueue('slot-1', 'run-1', text)

    scheduler.runFrames(30)

    const visible = updates.at(-1)?.text ?? ''
    expect(visible.length).toBeGreaterThanOrEqual(18)
    expect(visible.length).toBeLessThanOrEqual(21)
    expect(STREAM_REVEAL_CPS).toBeGreaterThanOrEqual(30)
    expect(STREAM_REVEAL_CPS).toBeLessThanOrEqual(45)
    expect(scheduler.frames.size).toBe(1)

    const updateGaps = updates
      .slice(1)
      .map((update, index) => update.atMs - updates[index]!.atMs)
    expect(Math.max(...updateGaps)).toBeLessThan(50)
  })

  it('preserves exact ordering and markdown across irregular arrivals', () => {
    const { controller, scheduler, updates } = createScene()
    const chunks = [
      '# Title\n\n',
      'A **bold',
      '** value and `co',
      'de`.\n\n- one\n- two',
    ]

    controller.enqueue('slot-1', 'run-1', chunks[0]!)
    scheduler.runFrames(9)
    controller.enqueue('slot-1', 'run-1', chunks[1]!)
    scheduler.runFrames(2)
    controller.enqueue('slot-1', 'run-1', chunks[2]!)
    scheduler.runFrames(17)
    controller.enqueue('slot-1', 'run-1', chunks[3]!)
    controller.finish(
      (entry) => entry.runId === 'run-1',
      () => {},
    )
    scheduler.runUntilNoFrames()

    expect(updates.at(-1)?.text).toBe(chunks.join(''))
  })

  it('uses a bounded catch-up rate for a long reply', () => {
    const { controller, scheduler, updates } = createScene()
    controller.enqueue('slot-1', 'run-1', 'z'.repeat(8_000))

    scheduler.runFrames(40, STREAM_MAX_FRAME_MS)

    const lengths = updates.map((update) => update.text.length)
    const frameDeltas = lengths.map((length, index) =>
      index === 0 ? length : length - lengths[index - 1]!,
    )
    const maxPerFrame = Math.ceil(
      (STREAM_CATCH_UP_MAX_CPS * STREAM_MAX_FRAME_MS) / 1000,
    )
    expect(Math.max(...frameDeltas)).toBeLessThanOrEqual(maxPerFrame)
    expect(lengths.at(-1)).toBeGreaterThan(STREAM_REVEAL_CPS * 1.5)
    expect(scheduler.frames.size).toBe(1)
  })

  it('does not turn a long renderer pause into a burst flush', () => {
    const { controller, scheduler, updates } = createScene()
    controller.enqueue('slot-1', 'run-1', 'p'.repeat(2_000))
    scheduler.runFrames(10)
    const beforePause = updates.at(-1)?.text.length ?? 0

    scheduler.pause(15_000)
    scheduler.advance()

    const afterPause = updates.at(-1)?.text.length ?? 0
    const maxClampedRelease = Math.ceil(
      (STREAM_CATCH_UP_MAX_CPS * STREAM_MAX_FRAME_MS) / 1000,
    )
    expect(afterPause - beforePause).toBeLessThanOrEqual(maxClampedRelease)
    expect(scheduler.frames.size).toBe(1)
  })

  it('smooths the captured Claude Code burst-stall-burst cadence', () => {
    const { controller, scheduler, updates } = createScene()
    let arrivalIndex = 0
    const frameMs = 1000 / 60
    for (
      let atMs = 0;
      atMs <= CLAUDE_CODE_CAPTURED_TRACE.completeAtMs;
      atMs += frameMs
    ) {
      while (
        arrivalIndex < CLAUDE_CODE_CAPTURED_TRACE.arrivals.length &&
        CLAUDE_CODE_CAPTURED_TRACE.arrivals[arrivalIndex]![0] <= atMs
      ) {
        const [, chars] = CLAUDE_CODE_CAPTURED_TRACE.arrivals[arrivalIndex]!
        controller.enqueue('slot-1', 'run-1', 'c'.repeat(chars))
        arrivalIndex += 1
      }
      scheduler.advance(frameMs)
    }
    controller.finish((entry) => entry.runId === 'run-1', () => {})
    scheduler.runUntilNoFrames()

    const totalChars = CLAUDE_CODE_CAPTURED_TRACE.arrivals.reduce(
      (sum, [, chars]) => sum + chars,
      0,
    )
    const lengths = updates.map((update) => update.text.length)
    const maxStep = Math.max(
      ...lengths.map((length, index) =>
        index === 0 ? length : length - lengths[index - 1]!,
      ),
    )
    expect(totalChars).toBe(1_169)
    expect(updates.at(-1)?.text).toBe('c'.repeat(totalChars))
    expect(maxStep).toBeLessThanOrEqual(
      Math.ceil((STREAM_FINISH_MAX_CPS * frameMs) / 1000),
    )
    expect(scheduler.time).toBeLessThan(
      CLAUDE_CODE_CAPTURED_TRACE.completeAtMs +
        STREAM_FINISH_FALLBACK_MS +
        100,
    )
  })

  it.each(['completion', 'cancel', 'error'])(
    'drains all received text promptly on %s',
    () => {
      const { controller, scheduler, updates } = createScene()
      const text = 'terminal text '.repeat(80)
      const drained: string[] = []
      controller.enqueue('slot-1', 'run-1', text)
      scheduler.runFrames(4)

      controller.finish(
        (entry) => entry.runId === 'run-1',
        (slotId) => drained.push(slotId),
      )
      scheduler.runUntilNoFrames()

      expect(updates.at(-1)?.text).toBe(text)
      expect(drained).toEqual(['slot-1'])
      expect(scheduler.time).toBeLessThanOrEqual(
        STREAM_FINISH_FALLBACK_MS + 100,
      )
      expect(scheduler.timers.size).toBe(0)
    },
  )

  it('keeps cumulative text correct if a finished slot resumes', () => {
    const { controller, scheduler, updates } = createScene()
    controller.enqueue('slot-1', 'run-1', 'hello')
    controller.finish(
      (entry) => entry.runId === 'run-1',
      () => {},
    )
    scheduler.runUntilNoFrames()

    controller.enqueue('slot-1', 'run-1', ' world')
    controller.finish(
      (entry) => entry.runId === 'run-1',
      () => {},
    )
    scheduler.runUntilNoFrames()

    expect(updates.at(-1)?.text).toBe('hello world')
  })

  it('cancels an in-progress terminal drain when the same slot reactivates', () => {
    const { controller, scheduler, updates } = createScene()
    const drained: string[] = []
    controller.enqueue('slot-1', 'run-1', 'first '.repeat(200))
    controller.finish(
      (entry) => entry.runId === 'run-1',
      (slotId) => drained.push(slotId),
    )
    scheduler.runFrames(3)

    controller.enqueue('slot-1', 'run-1', 'resumed')
    scheduler.pause(STREAM_FINISH_FALLBACK_MS * 2)
    scheduler.advance()

    expect(drained).toEqual([])
    expect(updates.at(-1)?.text.endsWith('resumed')).toBe(false)

    controller.finish(
      (entry) => entry.runId === 'run-1',
      (slotId) => drained.push(slotId),
    )
    scheduler.runUntilNoFrames()
    expect(updates.at(-1)?.text).toBe(`${'first '.repeat(200)}resumed`)
    expect(drained).toEqual(['slot-1'])
  })

  it('preserves a surrogate pair split across provider chunks', () => {
    const { controller, scheduler, updates } = createScene()
    controller.enqueue('slot-1', 'run-1', 'emoji: \ud83d')
    scheduler.runFrames(3)
    controller.enqueue('slot-1', 'run-1', '\ude80 done')
    controller.finish(
      (entry) => entry.runId === 'run-1',
      () => {},
    )
    scheduler.runUntilNoFrames()

    expect(updates.at(-1)?.text).toBe('emoji: \ud83d\ude80 done')
  })

  it('cancels frames and terminal timers during cleanup', () => {
    const { controller, scheduler, updates } = createScene()
    controller.enqueue('slot-1', 'run-1', 'never reveal this')
    controller.finish(
      (entry) => entry.runId === 'run-1',
      () => {},
    )

    controller.dispose()
    scheduler.pause(STREAM_FINISH_FALLBACK_MS * 2)
    scheduler.runFrames(3)

    expect(updates).toEqual([])
    expect(scheduler.frames.size).toBe(0)
    expect(scheduler.timers.size).toBe(0)
  })
})
