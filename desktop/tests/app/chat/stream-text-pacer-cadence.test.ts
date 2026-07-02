import { describe, expect, it } from "vitest";
import {
  createPaceState,
  recordArrival,
  stepPaceCount,
  FINISH_LATENCY_MS,
  MIN_PLAYOUT_CPS,
  RATE_SLEW_PER_SEC,
  START_HOLD_MS,
  START_MAX_HOLD_CHARS,
  START_MAX_HOLD_MS,
  type PaceState,
} from "@/features/chat/streaming/stream-text-pacer-cadence";

/** One 60fps frame. */
const DT = 1000 / 60;

const frames = (ms: number): number => Math.round(ms / DT);

/**
 * Feed clumps on a schedule, recording each arrival into the pace state (as
 * the pacer hook does), and drain through the cadence. Returns per-frame
 * release counts, per-frame backlog, and the per-frame smoothed velocity.
 */
function simulate(
  state: PaceState,
  feedPerFrame: (frame: number) => number,
  totalFrames: number,
): { counts: number[]; backlog: number[]; cps: number[] } {
  const counts: number[] = [];
  const backlog: number[] = [];
  const cps: number[] = [];
  let buf = 0;
  for (let f = 0; f < totalFrames; f += 1) {
    const fed = feedPerFrame(f);
    if (fed > 0) {
      recordArrival(state, fed, f * DT);
      buf += fed;
    }
    const c = stepPaceCount(state, buf, DT);
    buf -= c;
    counts.push(c);
    backlog.push(buf);
    cps.push(state.cps);
  }
  return { counts, backlog, cps };
}

/** Longest run of consecutive zero-release frames (the visible stalls). */
function longestStallFrames(counts: number[]): number {
  let longest = 0;
  let run = 0;
  for (const c of counts) {
    run = c === 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/** Coefficient of variation of `windowFrames`-sized release sums. */
function releaseRateCv(counts: number[], windowFrames: number): number {
  const sums: number[] = [];
  for (let i = 0; i + windowFrames <= counts.length; i += windowFrames) {
    sums.push(
      counts.slice(i, i + windowFrames).reduce((a, b) => a + b, 0),
    );
  }
  const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
  if (mean === 0) return Number.POSITIVE_INFINITY;
  const variance =
    sums.reduce((a, b) => a + (b - mean) ** 2, 0) / sums.length;
  return Math.sqrt(variance) / mean;
}

describe("stepPaceCount — jitter-buffer playout cadence", () => {
  it("returns 0 for an empty backlog and never over-releases", () => {
    const s = createPaceState();
    expect(stepPaceCount(s, 0, DT)).toBe(0);
    for (let i = 0; i < 200; i += 1) {
      expect(stepPaceCount(s, 3, DT)).toBeLessThanOrEqual(3);
    }
  });

  it("banks a startup cushion before the first character reveals", () => {
    // Fast steady feed: the rate is measurable after the second delta, so
    // the reveal holds for START_HOLD_MS of buffering, then starts.
    const state = createPaceState();
    const { counts } = simulate(state, () => 2, 120);
    const holdFrames = frames(START_HOLD_MS);
    expect(counts.slice(0, holdFrames - 1).every((c) => c === 0)).toBe(true);
    const afterHold = counts.slice(holdFrames, holdFrames + 30);
    expect(afterHold.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("starts a slow choppy stream cautiously and never stutters in warm-up", () => {
    // 20 chars every 2 s: only one clump has landed when the unknown-rate
    // hold cap expires, so the reveal starts paced to stretch that clump
    // over another hold-window — slow enough to survive until the second
    // clump makes the real rate measurable. The bar: from the very first
    // revealed character onward, no visible stall, even during warm-up.
    const state = createPaceState();
    const { counts } = simulate(
      state,
      (f) => (f % 120 === 0 ? 20 : 0),
      900,
    );
    const holdCapFrames = frames(START_MAX_HOLD_MS);
    expect(counts.slice(0, holdCapFrames - 2).every((c) => c === 0)).toBe(
      true,
    );
    const firstRelease = counts.findIndex((c) => c > 0);
    expect(firstRelease).toBeGreaterThan(0);
    expect(longestStallFrames(counts.slice(firstRelease))).toBeLessThan(
      frames(350),
    );
    // Velocity converges near the true 10 cps arrival rate.
    expect(state.cps).toBeGreaterThan(7);
    expect(state.cps).toBeLessThan(13);
  });

  it("starts promptly when a large clump is already buffered", () => {
    const state = createPaceState();
    recordArrival(state, START_MAX_HOLD_CHARS + 50, 0);
    const first = stepPaceCount(state, START_MAX_HOLD_CHARS + 50, DT);
    // Started (no hold) but not dumped: a frame's worth at most.
    expect(first).toBeLessThan(10);
    let released = first;
    for (let f = 1; f < 10; f += 1) {
      released += stepPaceCount(state, START_MAX_HOLD_CHARS + 50 - released, DT);
    }
    expect(released).toBeGreaterThan(0);
  });

  it("caps the hold when the rate never becomes measurable", () => {
    // One 40-char clump then silence (no second delta): reveal must start by
    // START_MAX_HOLD_MS anyway.
    const state = createPaceState();
    recordArrival(state, 40, 0);
    let buf = 40;
    const released: number[] = [];
    for (let f = 0; f < frames(START_MAX_HOLD_MS) + 60; f += 1) {
      const c = stepPaceCount(state, buf, DT);
      buf -= c;
      released.push(c);
    }
    const beforeCap = released.slice(0, frames(START_MAX_HOLD_MS) - 2);
    expect(beforeCap.every((c) => c === 0)).toBe(true);
    expect(
      released
        .slice(frames(START_MAX_HOLD_MS), frames(START_MAX_HOLD_MS) + 60)
        .reduce((a, b) => a + b, 0),
    ).toBeGreaterThan(0);
  });

  it("reveals a slow choppy stream as one continuous pour (no stalls, no dumps)", () => {
    // 20 chars every 2 s (~10 cps), maximally clumpy. Steady state must show
    // near-constant velocity: no visible stall, no multi-char frame dumps.
    const state = createPaceState();
    const { counts } = simulate(
      state,
      (f) => (f % 120 === 0 ? 20 : 0),
      2_400, // 40 s
    );
    const tail = counts.slice(1_200);
    // At ~9-10 cps a release lands every ~6-7 frames; a zero-run beyond
    // 0.5 s would be a visible stall.
    expect(longestStallFrames(tail)).toBeLessThan(30);
    expect(Math.max(...tail)).toBeLessThanOrEqual(2);
    // Throughput matches arrival (~10 cps ≈ 0.167/frame).
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeGreaterThan(0.12);
    expect(avg).toBeLessThan(0.22);
    // Smoothness: per-half-second reveal totals stay within a tight band.
    expect(releaseRateCv(tail, 30)).toBeLessThan(0.25);
  });

  it("keeps a very choppy stream smooth across multi-second gaps", () => {
    // 32 chars every 4 s (8 cps) — gaps far beyond the old fixed cushion.
    const state = createPaceState();
    const { counts } = simulate(
      state,
      (f) => (f % 240 === 0 ? 32 : 0),
      3_600, // 60 s
    );
    const tail = counts.slice(1_800);
    expect(longestStallFrames(tail)).toBeLessThan(40);
    expect(Math.max(...tail)).toBeLessThanOrEqual(2);
    expect(releaseRateCv(tail, 30)).toBeLessThan(0.3);
  });

  it("slew-limits velocity changes when the arrival rate jumps 10x", () => {
    const state = createPaceState();
    const { counts, cps } = simulate(
      state,
      (f) =>
        f < 600
          ? f % 30 === 0
            ? 5 // ~10 cps, clumpy
            : 0
          : f % 3 === 0
            ? 5 // ~100 cps
            : 0,
      1_200,
    );
    // After the jump, the velocity ramps — capped at RATE_SLEW_PER_SEC
    // fractional change per second (≈ e^slew over any 1s window).
    const maxRatioPerSecond = Math.exp(RATE_SLEW_PER_SEC) * 1.05;
    for (let f = 600; f + 60 < cps.length; f += 12) {
      expect(cps[f + 60] / cps[f]).toBeLessThan(maxRatioPerSecond);
    }
    // And it does get there: well above the slow rate a few seconds in.
    expect(cps[cps.length - 1]).toBeGreaterThan(60);
    // No per-frame jump once revealing (the pre-start seed happens while
    // nothing is on screen, so it is excluded — it has no visible effect).
    const firstRelease = counts.findIndex((c) => c > 0);
    for (let f = firstRelease + 2; f < cps.length; f += 1) {
      expect(Math.abs(cps[f] - cps[f - 1])).toBeLessThan(
        cps[f - 1] * RATE_SLEW_PER_SEC * (DT / 1000) * 1.5 + 0.01,
      );
    }
  });

  it("keeps up with a steady fast feed without unbounded lag", () => {
    // ~120 cps steady. Depth converges to the desired ~350 ms of latency,
    // so the backlog stays bounded rather than growing.
    const state = createPaceState();
    const { counts, backlog } = simulate(state, () => 2, 1_200);
    expect(Math.max(...backlog.slice(600))).toBeLessThan(150);
    const tail = counts.slice(600);
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeGreaterThan(1.7);
    expect(avg).toBeLessThan(2.3);
    expect(releaseRateCv(tail, 30)).toBeLessThan(0.15);
  });

  it("resumes without re-holding after the buffer briefly empties", () => {
    const state = createPaceState();
    // Warm up and start.
    simulate(state, (f) => (f % 6 === 0 ? 3 : 0), 120);
    expect(state.started).toBe(true);
    // Buffer empty for a while (arrival stall) — then a refill releases
    // promptly at the warm velocity, no fresh startup hold.
    for (let f = 0; f < 60; f += 1) stepPaceCount(state, 0, DT);
    let released = 0;
    for (let f = 0; f < 12; f += 1) {
      released += stepPaceCount(state, 30 - released, DT);
    }
    expect(released).toBeGreaterThan(0);
  });

  it("never crawls below the absolute floor while started", () => {
    const state = createPaceState();
    // Near-dead stream: a few chars every 4 s → arrival ~1 cps.
    for (let i = 0; i < 6; i += 1) recordArrival(state, 4, i * 4000);
    expect(state.arrivalCps).toBeLessThan(MIN_PLAYOUT_CPS);
    state.started = true;
    let remaining = 12;
    let count = 0;
    while (remaining > 0 && count < 600) {
      remaining -= stepPaceCount(state, remaining, DT);
      count += 1;
    }
    expect(remaining).toBe(0);
    // 12 chars at >= 6 cps completes within ~2 s (plus slack).
    expect(count * DT).toBeLessThan(2_600);
  });

  it("drains a finishing backlog promptly but not instantly", () => {
    // Stream end with text still buffered: the finish cadence bypasses the
    // startup hold and glides the tail out within ~FINISH_LATENCY_MS —
    // neither a single-frame dump nor a lingering trickle.
    const state = createPaceState();
    const counts: number[] = [];
    let remaining = 120;
    while (remaining > 0 && counts.length < 200) {
      const c = stepPaceCount(state, remaining, DT, true);
      remaining -= c;
      counts.push(c);
    }
    expect(remaining).toBe(0);
    expect(counts[0]).toBeLessThan(30);
    expect(counts.length * DT).toBeLessThanOrEqual(FINISH_LATENCY_MS * 2.5);
    expect(counts.length).toBeGreaterThan(3);
  });
});

describe("recordArrival — stream estimators", () => {
  it("converges to the mean rate of a bursty feed", () => {
    // 12 chars every 12 frames (~200 ms) is ~60 cps delivered in clumps.
    const state = createPaceState();
    for (let f = 0; f < 600; f += 1) {
      if (f % 12 === 0) recordArrival(state, 12, f * DT);
    }
    expect(state.arrivalCps).toBeGreaterThan(45);
    expect(state.arrivalCps).toBeLessThan(75);
    // The gap estimate reflects the clump period, not the in-burst deltas.
    expect(state.gapEmaMs).toBeGreaterThan(100);
    expect(state.gapEmaMs).toBeLessThan(300);
  });

  it("is unbiased for slow clumpy schedules", () => {
    const state = createPaceState();
    for (let i = 0; i < 30; i += 1) recordArrival(state, 20, i * 2000);
    expect(state.arrivalCps).toBeGreaterThan(9);
    expect(state.arrivalCps).toBeLessThan(11);
    expect(state.gapEmaMs).toBeGreaterThan(1_800);
    expect(state.gapEmaMs).toBeLessThan(2_200);
  });
});
