/**
 * Pure per-slot cadence model for `useStreamTextPacer`.
 *
 * Provider deltas arrive in bursts (a token, then a 40-char clump, then a
 * stall). The previous pacer set each frame's release to
 * `max(2, ceil(backlog / 6))` — i.e. the visible speed was a direct
 * function of the *instantaneous* backlog. Because the backlog swings with
 * every bursty delta, the reveal speed swung with it: a clump drained in a
 * fast burst over ~6 frames, the buffer emptied, the reveal stalled, then
 * the next clump burst again. Read: jerky, uneven pace.
 *
 * This models the release as a smoothed rate (code points per frame) that
 * *eases* toward the rate needed to drain the current backlog, instead of
 * snapping to it. A burst ramps the speed up over a few frames rather than
 * releasing a chunk at once, and a drain eases the speed down to a gentle
 * trickle rather than stopping abruptly — so the buffer also stays fuller
 * between deltas and bridges the small gaps that used to read as stalls. A
 * fractional accumulator turns sub-integer rates (e.g. 2.5) into an even
 * 2,3,2,3 cadence. A hard floor keyed off `MAX_CATCH_UP_FRAMES` guarantees
 * the buffer still never lags meaningfully behind the model, even mid-ramp.
 *
 * Kept pure (no React, no timers) so the cadence is unit-testable, matching
 * `streaming-text-reveal-frontier.ts`.
 */

/** Target latency: the rate eases toward draining the backlog this many frames. */
export const CATCH_UP_FRAMES = 6;
/**
 * Hard ceiling on latency: the rate is floored so the backlog always drains
 * within this many frames (~230ms at 60fps) even while the eased rate is
 * still ramping up to a sudden burst. Keeps the "never lag meaningfully"
 * guarantee that the old `ceil(backlog / CATCH_UP_FRAMES)` floor provided.
 */
export const MAX_CATCH_UP_FRAMES = 14;
/** Easing factor toward the target rate; limits per-frame accel and decel. */
export const RATE_SMOOTHING = 0.2;
/** Gentle floor so the tail of a buffer still trickles out at an even pace. */
export const MIN_RATE = 1.5;
/** Starting speed for a fresh slot, so the first characters ease in. */
export const INITIAL_RATE = 2;

export type PaceState = {
  /** Smoothed release rate, in code points per frame. */
  rate: number;
  /** Fractional carry so sub-integer rates produce an even integer cadence. */
  carry: number;
};

export const createPaceState = (): PaceState => ({
  rate: INITIAL_RATE,
  carry: 0,
});

/**
 * Advance the cadence one frame for a slot holding `backlog` buffered code
 * points. Mutates `state` and returns how many code points to release this
 * frame (always `>= 1` while `backlog > 0`, never more than `backlog`).
 */
export function stepPaceCount(state: PaceState, backlog: number): number {
  if (backlog <= 0) return 0;

  const target = backlog / CATCH_UP_FRAMES;
  // Ease toward the target so a burst ramps up and a drain eases down,
  // instead of the visible speed snapping between frames.
  let rate = state.rate + (target - state.rate) * RATE_SMOOTHING;
  // Never lag worse than MAX_CATCH_UP_FRAMES (even mid-ramp); keep a gentle
  // floor; never schedule more than is actually buffered.
  rate = Math.max(rate, backlog / MAX_CATCH_UP_FRAMES, MIN_RATE);
  rate = Math.min(rate, backlog);
  state.rate = rate;

  state.carry += rate;
  let count = Math.floor(state.carry);
  if (count < 1) count = 1;
  if (count > backlog) count = backlog;
  state.carry -= count;
  if (state.carry < 0) state.carry = 0;
  return count;
}
