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
 * ARRIVAL-ADAPTIVE PACING (slow / choppy streams):
 * The fixed knobs above tune well for healthy token rates (≳ 40 cps), but a
 * slow or choppy provider (a clump every couple of seconds) breaks the fixed
 * model three ways: the 18 cps floor OUTRUNS the model so the buffer empties
 * mid-gap and the reveal stalls; the 16-char cushion can't bridge a
 * multi-second gap; and the 900 ms latency cap burst-dumps a clump that lands
 * after a long gap. To fix that without touching the fast path, callers feed
 * every inbound chunk through `recordArrival`, which maintains two smoothed
 * estimates on the state:
 *   arrivalCps  exponentially-weighted arrival rate (chars/sec).
 *   gapEmaMs    time-weighted inter-arrival gap — long stalls dominate,
 *               dense in-burst deltas barely move it.
 * `stepPaceCount` then derives, per frame:
 *   floor    tracks slightly UNDER a slow model's arrival rate (so a cushion
 *            builds) instead of the fixed 18 cps; clamped so fast streams
 *            keep the exact fixed floor.
 *   cushion  grows to ~one typical gap's worth of text at the arrival rate,
 *            so the buffer holds enough to glide across the next gap.
 *   latency  the hard cap stretches toward the observed gap length (bounded
 *            by MAX_SLOW_LATENCY_MS), so a post-gap clump is absorbed into
 *            the continuous reveal rather than dumped inside 900 ms.
 * With no recorded arrivals (or a fast, steady stream) every derived value
 * collapses to the fixed knob, so the normal case is byte-identical.
 *
 * Stream end: `finishing: true` swaps the latency cap to FINISH_LATENCY_MS so
 * the remaining backlog glides out in ~a quarter second — prompt, but not the
 * instant dump a hard flush produces.
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
 *   ARRIVAL_TAU_MS           smoothing window for the arrival-rate estimate —
 *                            longer = steadier but slower to adapt. (1800)
 *   GAP_TAU_MS               smoothing window for the inter-arrival gap
 *                            estimate. (4000)
 *   SLOW_TRACK_RATIO         fraction of the arrival rate a slow stream's
 *                            floor tracks — < 1 so a cushion accrues. (0.9)
 *   SLOW_MIN_PLAYOUT_CPS     absolute floor so text never crawls unreadably
 *                            however slow the model. (6)
 *   GAP_LATENCY_HEADROOM     how much longer than a typical gap the latency
 *                            cap stretches on choppy streams. (2)
 *   MAX_SLOW_LATENCY_MS      ceiling for the stretched latency cap. (3200)
 *   MAX_CUSHION_CHARS        ceiling for the adaptive cushion. (320)
 *   FINISH_LATENCY_MS        drain window once the stream has ended. (280)
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
/** Smoothing window (ms) for the exponentially-weighted arrival rate. */
export const ARRIVAL_TAU_MS = 1800;
/** Smoothing window (ms) for the time-weighted inter-arrival gap. */
export const GAP_TAU_MS = 4000;
/** Slow streams reveal at this fraction of their arrival rate (cushion accrues). */
export const SLOW_TRACK_RATIO = 0.9;
/** Absolute reveal floor (chars/sec) — text never crawls slower than this. */
export const SLOW_MIN_PLAYOUT_CPS = 6;
/** Latency-cap stretch relative to the observed inter-arrival gap. Two gaps'
 *  worth: right after a clump lands the backlog is ~cushion + clump ≈ two
 *  gaps of text, and the cap must not fire on that normal steady state. */
export const GAP_LATENCY_HEADROOM = 2;
/** Ceiling (ms) for the stretched latency cap on choppy streams. */
export const MAX_SLOW_LATENCY_MS = 3200;
/** Ceiling (code points) for the adaptive gap-riding cushion. */
export const MAX_CUSHION_CHARS = 320;
/** Latency cap (ms) once the stream has ended — a fast glide, not a dump. */
export const FINISH_LATENCY_MS = 280;
/** Floor velocity (chars/sec) while finishing. The latency cap alone decays
 *  the backlog exponentially (rate ∝ remaining), leaving a long asymptotic
 *  tail; this floor makes the last stretch land linearly and promptly. */
export const FINISH_MIN_CPS = 120;

export type PaceState = {
  /** Smoothed display velocity, in code points per second. */
  cps: number;
  /** Fractional carry so sub-integer per-frame counts produce an even cadence. */
  carry: number;
  /** Exponentially-weighted arrival rate (code points/sec); 0 = no data yet. */
  arrivalCps: number;
  /** Time-weighted inter-arrival gap estimate (ms); 0 = no data yet. */
  gapEmaMs: number;
  /** Timestamp of the last recorded arrival (ms), or null before the first. */
  lastArrivalAtMs: number | null;
};

export const createPaceState = (): PaceState => ({
  cps: INITIAL_CPS,
  carry: 0,
  arrivalCps: 0,
  gapEmaMs: 0,
  lastArrivalAtMs: null,
});

/**
 * Record `count` code points arriving at `atMs`. Keeps the arrival-rate and
 * inter-arrival-gap estimates that `stepPaceCount` uses to adapt the reveal
 * to slow / choppy streams.
 *
 * Rate estimator: EMA over the instantaneous rate `count/gap`, with each
 * sample's blend weight scaling with its own gap length (time-weighted). This
 * is unbiased for clumpy schedules — e.g. 20 chars every 2 s converges to
 * exactly 10 cps, where a decay-then-add estimator sampled right after each
 * clump overshoots by ~1.6x for gaps comparable to τ.
 *
 * Gap estimator: same time-weighted EMA over the gaps themselves — a single
 * 3 s stall moves it sharply, while the dense ~0 ms deltas inside a burst
 * barely dilute it.
 *
 * The first arrival has no gap, so it leaves both estimates at 0 (= "no
 * data"; the cadence falls back to the fixed knobs until a second delta).
 */
export function recordArrival(
  state: PaceState,
  count: number,
  atMs: number,
): void {
  if (count <= 0) return;
  const last = state.lastArrivalAtMs;
  state.lastArrivalAtMs = atMs;
  if (last === null || atMs < last) return;
  const gap = Math.max(atMs - last, 1);
  const instantCps = (count * 1000) / gap;
  const alpha = 1 - Math.exp(-gap / ARRIVAL_TAU_MS);
  state.arrivalCps += (instantCps - state.arrivalCps) * alpha;
  const gapAlpha = 1 - Math.exp(-gap / GAP_TAU_MS);
  state.gapEmaMs += (gap - state.gapEmaMs) * gapAlpha;
}

/**
 * Advance the playout cadence by one frame of `dtMs` for a slot holding
 * `backlog` buffered code points. Mutates `state` and returns how many code
 * points to release this frame (`0` is valid for a sub-one-per-frame velocity;
 * the carry releases evenly across frames). Never returns more than `backlog`.
 *
 * `finishing: true` means the stream has ended for this slot: the latency cap
 * drops to `FINISH_LATENCY_MS` so the backlog glides out promptly instead of
 * trickling on (or being dumped by a hard flush).
 */
export function stepPaceCount(
  state: PaceState,
  backlog: number,
  dtMs: number,
  finishing = false,
): number {
  if (backlog <= 0) return 0;
  const dt = Math.min(Math.max(dtMs, 1), MAX_FRAME_MS) / 1000;

  // Arrival-adaptive floor: a slow model's reveal tracks slightly under its
  // own arrival rate (so a cushion accrues instead of the buffer being
  // outrun), never above the fixed floor (fast path unchanged) and never
  // below an absolute readability floor.
  const arrival = state.arrivalCps;
  const floor =
    arrival > 0 && arrival * SLOW_TRACK_RATIO < MIN_PLAYOUT_CPS
      ? Math.max(arrival * SLOW_TRACK_RATIO, SLOW_MIN_PLAYOUT_CPS)
      : MIN_PLAYOUT_CPS;

  // Arrival-adaptive cushion: on a choppy stream, hold ~one typical gap's
  // worth of text (at the arrival rate) so the reveal glides across the next
  // gap instead of stalling. Smooth/fast streams keep the fixed setpoint.
  const gapCushion = (arrival * state.gapEmaMs) / 1000;
  const cushion = Math.min(
    Math.max(SOFT_TARGET_CHARS, gapCushion),
    MAX_CUSHION_CHARS,
  );

  // Depth-steered target velocity: stays at the floor until the buffer is
  // deeper than the setpoint, then rises proportionally. Self-tunes to the
  // arrival rate (the buffer settles where target == arrival), clamped to the
  // smooth band.
  const depthError = backlog - cushion;
  let target = floor + Math.max(0, depthError) * DEPTH_GAIN_CPS_PER_CHAR;
  if (target > MAX_PLAYOUT_CPS) target = MAX_PLAYOUT_CPS;

  // Low-pass the velocity (frame-rate independent) so bursts/gaps don't snap
  // it — this is what turns bursty arrival into a near-constant visual rate.
  const alpha = 1 - Math.exp(-VELOCITY_SMOOTHING_HZ * dt);
  state.cps += (target - state.cps) * alpha;
  if (state.cps < floor) state.cps = floor;

  // Hard latency cap: if the buffer would represent more than the allowed
  // delay at the smoothed velocity, drain faster this frame to catch up
  // (bounds lag; finishes a fast model / end-of-burst promptly). Applied
  // WITHOUT writing back into `state.cps`, so the velocity eases back down
  // afterward instead of latching the spike. The allowance stretches toward
  // the observed inter-arrival gap on choppy streams (a post-gap clump is
  // paced into the reveal, not dumped) and collapses to FINISH_LATENCY_MS
  // once the stream has ended.
  let latencyMs = MAX_LATENCY_MS;
  if (finishing) {
    latencyMs = FINISH_LATENCY_MS;
  } else if (state.gapEmaMs > 0) {
    latencyMs = Math.min(
      Math.max(MAX_LATENCY_MS, state.gapEmaMs * GAP_LATENCY_HEADROOM),
      MAX_SLOW_LATENCY_MS,
    );
  }
  let cps = state.cps;
  const latencyCps = (backlog * 1000) / latencyMs;
  if (latencyCps > cps) cps = latencyCps;
  if (finishing && cps < FINISH_MIN_CPS) cps = FINISH_MIN_CPS;

  state.carry += cps * dt;
  let count = Math.floor(state.carry);
  if (count <= 0) return 0;
  if (count > backlog) count = backlog;
  state.carry -= count;
  if (state.carry < 0) state.carry = 0;
  return count;
}
