/**
 * Pure per-slot playout-buffer cadence for `useStreamTextPacer`.
 *
 * Provider tokens arrive in bursts (a token, a 40-char clump, a stall). To
 * make the on-screen text read as a steady typewriter that HIDES that jitter,
 * this drains the buffer like a video/audio playout buffer: a smooth display
 * VELOCITY (chars/sec) that is steered by how deep the buffer is, not by the
 * instantaneous arrival.
 *
 * Why the previous model still stuttered: it set the per-frame release to
 * `backlog / CATCH_UP_FRAMES` (and floored at `backlog / MAX_CATCH_UP_FRAMES`),
 * i.e. the velocity was proportional to the *instantaneous backlog* and the
 * buffer was designed to drain to EMPTY within ~6-14 frames. That can't hold a
 * cushion, so a clump drained in a fast burst, the buffer emptied, the reveal
 * stalled until the next clump, then burst again — the visible text tracked
 * the bursty arrival.
 *
 * New model (this file):
 *  - The display velocity eases (low-pass) toward a target that rises gently
 *    only as the buffer fills past a soft setpoint, so a single burst barely
 *    moves the velocity (no dump) and a gap doesn't stall it (it keeps
 *    draining the cushion at its steady rate).
 *  - The proportional depth term makes the steady-state velocity self-tune to
 *    the model's average arrival rate: the buffer settles at the depth where
 *    `target == arrival`, so the average display rate equals the average
 *    arrival rate (no unbounded drift) while the per-burst jitter is filtered
 *    out.
 *  - A hard latency cap guarantees the visible text never falls more than
 *    `MAX_LATENCY_MS` behind the model: a fast model (or the end of a burst)
 *    accelerates to catch up promptly, so the text is never seconds stale and
 *    a fast finish doesn't crawl.
 *
 * Velocity is in chars/sec and integrated with the real frame `dt`, so the
 * cadence is frame-rate independent (a dropped frame releases proportionally
 * more, keeping the visual rate constant) and a tab stall can't dump the
 * buffer (dt is clamped).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * TUNING KNOBS (safe to adjust; all exported):
 *   SOFT_TARGET_CHARS        cushion the buffer aims to hold — bigger = smoother
 *                            across gaps but more lag. (default 16)
 *   DEPTH_GAIN_CPS_PER_CHAR  how much faster per char of buffer above the
 *                            setpoint — higher = catches a burst sooner / less
 *                            cushion drift. (default 1.4)
 *   MIN_PLAYOUT_CPS          slowest steady reveal while draining — keep below
 *                            slow-model rates so it tracks, not outruns, them.
 *                            (default 18)
 *   MAX_PLAYOUT_CPS          ceiling for the SMOOTH band (≈ comfortable fast
 *                            read); beyond this only the latency cap speeds up.
 *                            (default 190)
 *   INITIAL_CPS              starting velocity before the buffer settles.
 *                            (default 30)
 *   VELOCITY_SMOOTHING_HZ    low-pass cutoff for velocity changes — higher =
 *                            snappier ramps, lower = glassier. (default 6)
 *   MAX_LATENCY_MS           hard cap on how far the text may lag the model;
 *                            the catch-up floor that finishes fast models
 *                            promptly. (default 900)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Kept pure (no React, no timers; `dt` is passed in) so the cadence is
 * unit-testable, matching `streaming-text-reveal-frontier.ts`.
 */

/** Cushion (code points) the buffer aims to hold to ride arrival gaps. */
export const SOFT_TARGET_CHARS = 16;
/** Velocity rise (chars/sec) per code point of buffer above the setpoint. */
export const DEPTH_GAIN_CPS_PER_CHAR = 1.4;
/** Slowest steady reveal velocity while text remains buffered (chars/sec). */
export const MIN_PLAYOUT_CPS = 18;
/** Ceiling of the smooth velocity band (chars/sec). */
export const MAX_PLAYOUT_CPS = 190;
/** Velocity a fresh slot starts at before the buffer settles (chars/sec). */
export const INITIAL_CPS = 30;
/** Low-pass cutoff (Hz) for how fast the display velocity may change. */
export const VELOCITY_SMOOTHING_HZ = 6;
/** Hard cap (ms) on how far the visible text may lag the model. */
export const MAX_LATENCY_MS = 900;
/** Frame-time clamp (ms): a tab stall / GC pause can't dump the buffer. */
export const MAX_FRAME_MS = 64;

export type PaceState = {
  /** Smoothed display velocity, in code points per second. */
  cps: number;
  /** Fractional carry so sub-integer per-frame counts produce an even cadence. */
  carry: number;
};

export const createPaceState = (): PaceState => ({
  cps: INITIAL_CPS,
  carry: 0,
});

/**
 * Advance the playout cadence by one frame of `dtMs` for a slot holding
 * `backlog` buffered code points. Mutates `state` and returns how many code
 * points to release this frame (`0` is valid for a sub-one-per-frame velocity;
 * the carry releases evenly across frames). Never returns more than `backlog`.
 */
export function stepPaceCount(
  state: PaceState,
  backlog: number,
  dtMs: number,
): number {
  if (backlog <= 0) return 0;
  const dt = Math.min(Math.max(dtMs, 1), MAX_FRAME_MS) / 1000;

  // Depth-steered target velocity: stays at the floor until the buffer is
  // deeper than the setpoint, then rises proportionally. Self-tunes to the
  // arrival rate (the buffer settles where target == arrival), clamped to the
  // smooth band.
  const depthError = backlog - SOFT_TARGET_CHARS;
  let target = MIN_PLAYOUT_CPS + Math.max(0, depthError) * DEPTH_GAIN_CPS_PER_CHAR;
  if (target > MAX_PLAYOUT_CPS) target = MAX_PLAYOUT_CPS;

  // Low-pass the velocity (frame-rate independent) so bursts/gaps don't snap
  // it — this is what turns bursty arrival into a near-constant visual rate.
  const alpha = 1 - Math.exp(-VELOCITY_SMOOTHING_HZ * dt);
  state.cps += (target - state.cps) * alpha;
  if (state.cps < MIN_PLAYOUT_CPS) state.cps = MIN_PLAYOUT_CPS;

  // Hard latency cap: if the buffer would represent more than MAX_LATENCY_MS
  // of delay at the smoothed velocity, drain faster this frame to catch up
  // (bounds lag; finishes a fast model / end-of-burst promptly). Applied
  // WITHOUT writing back into `state.cps`, so the velocity eases back down
  // afterward instead of latching the spike.
  let cps = state.cps;
  const latencyCps = (backlog * 1000) / MAX_LATENCY_MS;
  if (latencyCps > cps) cps = latencyCps;

  state.carry += cps * dt;
  let count = Math.floor(state.carry);
  if (count <= 0) return 0;
  if (count > backlog) count = backlog;
  state.carry -= count;
  if (state.carry < 0) state.carry = 0;
  return count;
}
