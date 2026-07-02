/**
 * Pure per-slot playout cadence for `useStreamTextPacer` — a JITTER BUFFER.
 *
 * Provider tokens arrive in bursts at wildly varying rates (a token, a
 * 40-char clump, a multi-second stall). The design goal, in priority order:
 *
 *   1. CONSTANT PERCEIVED VELOCITY — the on-screen reveal should read as one
 *      continuous smooth pour for the whole turn, never mirroring arrival
 *      chop. Added latency is an accepted cost.
 *   2. Prompt finish — when the stream ends, the remaining backlog glides
 *      out quickly (but never dumps in a single frame).
 *
 * Model (classic playout/jitter buffer):
 *
 *   STARTUP CUSHION  A fresh slot holds fully hidden until it has buffered
 *                    `START_HOLD_MS` of content — and until the arrival rate
 *                    is measurable (needs a second delta), bounded by
 *                    `START_MAX_HOLD_MS` / `START_MAX_HOLD_CHARS`. The reveal
 *                    then starts pre-loaded with a lookahead cushion and its
 *                    velocity SEEDED from the measured arrival rate (slightly
 *                    under it, so the cushion keeps growing toward target).
 *
 *   RATE TRACKING    The playout velocity targets the smoothed arrival rate
 *                    (`recordArrival`'s time-weighted EMA), nudged by a small
 *                    buffer-health correction (bounded ±MAX_RATE_CORRECTION)
 *                    that steers the buffered depth toward one "desired
 *                    latency" worth of text — itself adapted to the observed
 *                    inter-arrival gap so choppier providers hold deeper
 *                    cushions. The correction is deliberately weak: latency
 *                    drift corrects invisibly over seconds instead of the
 *                    velocity visibly chasing every clump.
 *
 *   SLEW LIMITING    The velocity may change by at most `RATE_SLEW_PER_SEC`
 *                    (fractional) per second, on top of a low-pass filter.
 *                    Even a 10x arrival-rate shift ramps over ~2-3 s — speed
 *                    changes are below the threshold of notice, and a
 *                    per-frame rate jump is structurally impossible.
 *
 *   STREAM END       `finishing: true` bypasses the hold and drains the
 *                    backlog within ~FINISH_LATENCY_MS (with a FINISH_MIN_CPS
 *                    floor so the tail lands linearly) — prompt, but a glide
 *                    rather than a dump.
 *
 *   EMERGENCY VALVE  Outside of finishing, a backlog representing more than
 *                    `EMERGENCY_LAG_MS` of delay drains proportionally faster
 *                    (pathological mid-message dumps only; normal operation
 *                    never touches it).
 *
 * Velocity is chars/sec integrated with the real frame `dt` (frame-rate
 * independent; `dt` clamped so a tab stall can't dump the buffer). Kept pure
 * (no React, no timers) so the cadence is unit-testable, matching
 * `streaming-text-reveal-frontier.ts`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * TUNING KNOBS (safe to adjust; all exported):
 *   START_HOLD_MS            startup cushion: content buffered before the
 *                            first character reveals. (300)
 *   START_MAX_HOLD_MS        reveal starts by this even if the arrival rate
 *                            is still unknown (single-clump case). (1200)
 *   START_MAX_HOLD_CHARS     ...or once this much text is already waiting. (150)
 *   START_SEED_RATIO         starting velocity as a fraction of the measured
 *                            arrival rate — < 1 so the cushion grows. (0.9)
 *   TARGET_LATENCY_MIN_MS    smallest steady-state playout delay. (350)
 *   TARGET_LATENCY_MAX_MS    largest steady-state playout delay. (3500)
 *   GAP_LATENCY_MARGIN       desired delay vs the observed inter-arrival gap
 *                            (1.5 gaps of cushion). (1.5)
 *   DEPTH_ERROR_GAIN         how strongly buffer-depth error nudges the rate
 *                            — small = steadier, slower latency correction. (0.25)
 *   MAX_RATE_CORRECTION      bound on that nudge, as a fraction of the
 *                            arrival rate. (0.3)
 *   RATE_SMOOTHING_HZ        low-pass cutoff for velocity changes. (2)
 *   RATE_SLEW_PER_SEC        hard cap on fractional velocity change per
 *                            second. (0.8)
 *   MIN_PLAYOUT_CPS          absolute reveal floor — text never crawls
 *                            unreadably. (6)
 *   MAX_PLAYOUT_CPS          smooth-band ceiling (≈ comfortable fast read);
 *                            only finish/emergency exceed it. (190)
 *   INITIAL_CPS              fallback velocity when the reveal must start
 *                            before any rate is measurable. (30)
 *   ARRIVAL_TAU_MS           smoothing window for the arrival-rate EMA. (1800)
 *   GAP_TAU_MS               smoothing window for the gap EMA. (4000)
 *   EMERGENCY_LAG_MS         mid-stream lag bound (pathological only). (6000)
 *   FINISH_LATENCY_MS        drain window once the stream has ended. (280)
 *   FINISH_MIN_CPS           linear-landing floor while finishing. (120)
 * ──────────────────────────────────────────────────────────────────────────
 */

/** Startup cushion (ms of buffered content) before the first reveal. */
export const START_HOLD_MS = 300;
/** Hard bound on the startup hold when the arrival rate stays unknown. */
export const START_MAX_HOLD_MS = 1200;
/** Start immediately once this much text is already buffered. */
export const START_MAX_HOLD_CHARS = 150;
/** Starting velocity as a fraction of the measured arrival rate. */
export const START_SEED_RATIO = 0.9;
/** Smallest steady-state playout delay the buffer aims to hold (ms). */
export const TARGET_LATENCY_MIN_MS = 350;
/** Largest steady-state playout delay the buffer aims to hold (ms). */
export const TARGET_LATENCY_MAX_MS = 3500;
/** Desired playout delay relative to the observed inter-arrival gap. */
export const GAP_LATENCY_MARGIN = 1.5;
/** Fractional rate nudge per unit of buffer-depth error. */
export const DEPTH_ERROR_GAIN = 0.25;
/** Bound on the depth nudge, as a fraction of the arrival rate. */
export const MAX_RATE_CORRECTION = 0.3;
/** Low-pass cutoff (Hz) for velocity changes. */
export const RATE_SMOOTHING_HZ = 2;
/** Hard cap on fractional velocity change per second (slew limit). */
export const RATE_SLEW_PER_SEC = 0.8;
/** Absolute reveal floor (chars/sec). */
export const MIN_PLAYOUT_CPS = 6;
/** Ceiling of the smooth velocity band (chars/sec). */
export const MAX_PLAYOUT_CPS = 190;
/** Fallback starting velocity when no arrival rate is measurable. */
export const INITIAL_CPS = 30;
/** Frame-time clamp (ms): a tab stall / GC pause can't dump the buffer. */
export const MAX_FRAME_MS = 64;
/** Smoothing window (ms) for the exponentially-weighted arrival rate. */
export const ARRIVAL_TAU_MS = 1800;
/** Smoothing window (ms) for the time-weighted inter-arrival gap. */
export const GAP_TAU_MS = 4000;
/** Evidence mass (Σ decayed sample weights, ≈ 300 ms of inter-arrival time
 *  at τ=1800) before the arrival-rate estimate counts as trustworthy. Two
 *  deltas microseconds apart must NOT unlock the startup hold with a wild
 *  instantaneous rate. */
export const RATE_CONFIDENCE_WEIGHT = 0.15;
/** Mid-stream lag bound (ms) — the emergency drain valve. */
export const EMERGENCY_LAG_MS = 6000;
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
  /** Bias-corrected arrival-rate estimate (code points/sec); 0 = no data. */
  arrivalCps: number;
  /** Accumulated evidence mass behind `arrivalCps` (0..1). */
  arrivalWeight: number;
  /** Bias-corrected inter-arrival gap estimate (ms); 0 = no data yet. */
  gapEmaMs: number;
  /** Accumulated evidence mass behind `gapEmaMs` (0..1). */
  gapWeight: number;
  /** Timestamp of the last recorded arrival (ms), or null before the first. */
  lastArrivalAtMs: number | null;
  /** Time (ms) spent buffering content during the startup hold. */
  heldMs: number;
  /** Whether the reveal has started (the startup hold is over). */
  started: boolean;
};

export const createPaceState = (): PaceState => ({
  cps: INITIAL_CPS,
  carry: 0,
  arrivalCps: 0,
  arrivalWeight: 0,
  gapEmaMs: 0,
  gapWeight: 0,
  lastArrivalAtMs: null,
  heldMs: 0,
  started: false,
});

/**
 * Record `count` code points arriving at `atMs`. Keeps the arrival-rate and
 * inter-arrival-gap estimates that `stepPaceCount` uses to pace the reveal.
 *
 * Rate estimator: BIAS-CORRECTED EMA over the instantaneous rate
 * `count/gap`, with each sample's blend weight scaling with its own gap
 * length (time-weighted). Time-weighting makes it unbiased for clumpy
 * schedules — 20 chars every 2 s converges to exactly 10 cps — and the bias
 * correction (dividing out the accumulated evidence mass, implemented as an
 * effective alpha of `a/w`) removes the toward-zero warm-up skew of a
 * zero-initialized EMA, so the estimate is usable within the startup hold
 * instead of lagging the true rate for seconds and letting the buffer
 * balloon.
 *
 * Gap estimator: same construction over the gaps themselves — a single 3 s
 * stall moves it sharply, while the dense ~0 ms deltas inside a burst barely
 * dilute it.
 *
 * The first arrival has no gap, so it leaves both estimates empty; the
 * `*Weight` fields say how much evidence stands behind each estimate
 * (`RATE_CONFIDENCE_WEIGHT` gates the startup hold on that).
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
  state.arrivalWeight += (1 - state.arrivalWeight) * alpha;
  state.arrivalCps += (instantCps - state.arrivalCps) * (alpha / state.arrivalWeight);
  const gapAlpha = 1 - Math.exp(-gap / GAP_TAU_MS);
  state.gapWeight += (1 - state.gapWeight) * gapAlpha;
  state.gapEmaMs += (gap - state.gapEmaMs) * (gapAlpha / state.gapWeight);
}

const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

/**
 * Advance the playout cadence by one frame of `dtMs` for a slot holding
 * `backlog` buffered code points. Mutates `state` and returns how many code
 * points to release this frame (`0` is valid — during the startup hold, and
 * for sub-one-per-frame velocities whose fractional carry releases evenly
 * across frames). Never returns more than `backlog`.
 *
 * `finishing: true` means the stream has ended for this slot: the startup
 * hold is bypassed and the backlog drains within ~FINISH_LATENCY_MS.
 */
export function stepPaceCount(
  state: PaceState,
  backlog: number,
  dtMs: number,
  finishing = false,
): number {
  if (backlog <= 0) return 0;
  const dtClampedMs = Math.min(Math.max(dtMs, 1), MAX_FRAME_MS);
  const dt = dtClampedMs / 1000;

  // ── Startup cushion ────────────────────────────────────────────────────
  // Hold fully hidden until enough content is buffered AND the arrival rate
  // is measurable, so the reveal starts at the stream's own pace with a
  // lookahead cushion already banked (bounded so a single-clump message or
  // a big first dump never waits long).
  if (!state.started) {
    const rateKnown = state.arrivalWeight >= RATE_CONFIDENCE_WEIGHT;
    if (!finishing) {
      state.heldMs += dtClampedMs;
      const heldLongEnough = rateKnown
        ? state.heldMs >= START_HOLD_MS
        : state.heldMs >= START_MAX_HOLD_MS;
      if (!heldLongEnough && backlog < START_MAX_HOLD_CHARS) return 0;
    }
    state.started = true;
    // Seed the velocity from the measured rate (slightly under it so the
    // cushion keeps growing toward the desired latency). Nothing has been
    // revealed yet, so the seed is free — no visible speed jump.
    if (rateKnown) {
      state.cps = clamp(
        state.arrivalCps * START_SEED_RATIO,
        MIN_PLAYOUT_CPS,
        MAX_PLAYOUT_CPS,
      );
    } else if (!finishing) {
      // Rate unknowable (a single clump so far): stretch the held text
      // over a full worst-case playout window rather than guessing fast —
      // a provider this sparse is likely slow, and outrunning it stalls
      // the reveal (the slew-limited ramp recovers quickly if it turns
      // out to be fast).
      state.cps = clamp(
        (backlog * 1000) / TARGET_LATENCY_MAX_MS,
        MIN_PLAYOUT_CPS,
        MAX_PLAYOUT_CPS,
      );
    }
  }

  // ── Target velocity: track the arrival rate, gently steer the depth ─────
  const arrival = state.arrivalCps;
  let target = state.cps; // no trustworthy rate yet → hold course
  if (arrival > 0 && state.arrivalWeight >= RATE_CONFIDENCE_WEIGHT) {
    const desiredLatencyMs = clamp(
      state.gapEmaMs * GAP_LATENCY_MARGIN,
      TARGET_LATENCY_MIN_MS,
      TARGET_LATENCY_MAX_MS,
    );
    const desiredDepth = Math.max(1, (arrival * desiredLatencyMs) / 1000);
    const depthError = (backlog - desiredDepth) / desiredDepth;
    const correction = clamp(
      depthError * DEPTH_ERROR_GAIN,
      -MAX_RATE_CORRECTION,
      MAX_RATE_CORRECTION,
    );
    target = arrival * (1 + correction);
  }
  target = clamp(target, MIN_PLAYOUT_CPS, MAX_PLAYOUT_CPS);

  // ── Smooth + slew-limit the velocity ────────────────────────────────────
  // Low-pass toward the target, then hard-cap the fractional change per
  // second: even a 10x arrival shift ramps over seconds, so the perceived
  // speed never jumps frame-to-frame.
  const alpha = 1 - Math.exp(-RATE_SMOOTHING_HZ * dt);
  const eased = state.cps + (target - state.cps) * alpha;
  const maxStep = state.cps * RATE_SLEW_PER_SEC * dt;
  state.cps = clamp(
    clamp(eased, state.cps - maxStep, state.cps + maxStep),
    MIN_PLAYOUT_CPS,
    MAX_PLAYOUT_CPS,
  );

  // ── Release ─────────────────────────────────────────────────────────────
  // Finishing and the emergency valve act on the frame's effective velocity
  // WITHOUT writing back into `state.cps`, so the smooth rate resumes cleanly
  // if more text arrives.
  let cps = state.cps;
  if (finishing) {
    const finishCps = (backlog * 1000) / FINISH_LATENCY_MS;
    cps = Math.max(cps, finishCps, FINISH_MIN_CPS);
  } else {
    const emergencyCps = (backlog * 1000) / EMERGENCY_LAG_MS;
    if (emergencyCps > cps) cps = emergencyCps;
  }

  state.carry += cps * dt;
  let count = Math.floor(state.carry);
  if (count <= 0) return 0;
  if (count > backlog) count = backlog;
  state.carry -= count;
  if (state.carry < 0) state.carry = 0;
  return count;
}
