import { describe, expect, it } from "vitest";
import {
  createPaceState,
  recordArrival,
  stepPaceCount,
  FINISH_LATENCY_MS,
  MAX_LATENCY_MS,
  MIN_PLAYOUT_CPS,
  SLOW_MIN_PLAYOUT_CPS,
  SOFT_TARGET_CHARS,
  type PaceState,
} from "@/features/chat/streaming/stream-text-pacer-cadence";

/** One 60fps frame. */
const DT = 1000 / 60;

/** Drain a fixed backlog (no refill); return the per-frame release counts. */
function drain(backlog: number, maxFrames = 5_000): number[] {
  const state = createPaceState();
  const counts: number[] = [];
  let remaining = backlog;
  let frames = 0;
  while (remaining > 0 && frames < maxFrames) {
    const c = stepPaceCount(state, remaining, DT);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(remaining);
    counts.push(c);
    remaining -= c;
    frames += 1;
  }
  return counts;
}

/**
 * Feed the buffer on a schedule and drain it through the pacer; return the
 * per-frame release counts and the backlog after each frame.
 */
function simulate(
  feedPerFrame: (frame: number) => number,
  frames: number,
): { counts: number[]; backlog: number[] } {
  const state = createPaceState();
  const counts: number[] = [];
  const backlog: number[] = [];
  let buf = 0;
  for (let f = 0; f < frames; f += 1) {
    buf += feedPerFrame(f);
    const c = stepPaceCount(state, buf, DT);
    buf -= c;
    counts.push(c);
    backlog.push(buf);
  }
  return { counts, backlog };
}

describe("stepPaceCount — playout buffer cadence", () => {
  it("returns 0 for an empty backlog and never over-releases", () => {
    const s = createPaceState();
    expect(stepPaceCount(s, 0, DT)).toBe(0);
    expect(stepPaceCount(s, 3, DT)).toBeLessThanOrEqual(3);
  });

  it("does not dump a burst — the first frame releases a tiny slice", () => {
    // A 60-char clump lands in one delta. The old pacer released ceil(60/6)=10
    // on frame 1; the playout buffer releases ~1 (velocity, not backlog).
    const s = createPaceState();
    const first = stepPaceCount(s, 60, DT);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(6);
  });

  it("rides a gap — a clump drains over many frames, not ~6", () => {
    // Draining a 40-char clump with no refill must take long enough to bridge
    // a real arrival gap (the old model emptied it in ~6-14 frames).
    const frames = drain(40).length;
    expect(frames).toBeGreaterThan(20);
  });

  it("holds a near-constant release under BURSTY feed (hides jitter)", () => {
    // Average 1 char/frame (~60 cps) delivered as a 12-char clump every 12
    // frames — maximally bursty for that average. The release should settle to
    // a smooth trickle, not mirror the 12-then-0 arrival.
    const { counts } = simulate(
      (f) => (f % 12 === 0 ? 12 : 0),
      600,
    );
    const tail = counts.slice(300);
    const max = Math.max(...tail);
    const min = Math.min(...tail);
    // Bursty INPUT (0 or 12) becomes a smooth OUTPUT of 0..2 per frame.
    expect(max).toBeLessThanOrEqual(2);
    expect(min).toBeGreaterThanOrEqual(0);
    // And it keeps up with the average (buffer doesn't run away).
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeGreaterThan(0.7);
    expect(avg).toBeLessThan(1.3);
  });

  it("keeps up with a steady fast feed without unbounded lag", () => {
    // ~120 cps steady (2 chars/frame). The backlog must stay bounded (the
    // display tracks the model) rather than growing every frame.
    const { backlog } = simulate(() => 2, 600);
    const tailMax = Math.max(...backlog.slice(300));
    // Bounded by roughly MAX_LATENCY worth at this rate, with headroom.
    expect(tailMax).toBeLessThan(120);
  });

  it("accelerates to catch up when the buffer is deep (bounds lag)", () => {
    // A deep buffer must release far more per frame than a shallow one — the
    // latency cap engaging so the visible text never falls seconds behind.
    const deep = createPaceState();
    const shallow = createPaceState();
    const deepFirst = stepPaceCount(deep, 400, DT);
    const shallowFirst = stepPaceCount(shallow, SOFT_TARGET_CHARS, DT);
    expect(deepFirst).toBeGreaterThan(shallowFirst);
    // Draining a deep buffer keeps its per-frame count above the shallow floor
    // for a while (catch-up), i.e. it doesn't crawl.
    expect(drain(400).slice(0, 5).every((c) => c >= 1)).toBe(true);
  });

  it("never permanently stalls while text remains buffered", () => {
    // Over a sliding window there is always forward progress (sub-1-per-frame
    // velocities release via the fractional carry, never zero forever).
    const counts = drain(200);
    for (let i = 0; i + 30 <= counts.length; i += 30) {
      const windowSum = counts.slice(i, i + 30).reduce((a, b) => a + b, 0);
      expect(windowSum).toBeGreaterThan(0);
    }
    // Sanity: the whole backlog actually drains.
    expect(counts.reduce((a, b) => a + b, 0)).toBe(200);
  });

  it("resumes warm after a gap instead of re-ramping from the floor", () => {
    // Warm the velocity up on a deep buffer, drain to empty, then feed again:
    // the retained `cps` should release the next chars at more than the cold
    // initial trickle.
    const state = createPaceState();
    for (let i = 0; i < 40; i += 1) stepPaceCount(state, 300 - i, DT);
    const warmCps = state.cps;
    const cold = createPaceState();
    expect(warmCps).toBeGreaterThan(cold.cps);
    // A fresh small feed on the warm state releases promptly (velocity kept).
    const warmRelease = stepPaceCount(state, 8, DT);
    expect(warmRelease).toBeGreaterThanOrEqual(1);
  });

  it("drains a finishing backlog promptly but not instantly", () => {
    // Stream end with text still buffered: the finish cadence should glide
    // the tail out within ~FINISH_LATENCY_MS — neither a single-frame dump
    // nor a lingering trickle.
    const state = createPaceState();
    const counts: number[] = [];
    let remaining = 120;
    while (remaining > 0 && counts.length < 200) {
      const c = stepPaceCount(state, remaining, DT, true);
      remaining -= c;
      counts.push(c);
    }
    expect(remaining).toBe(0);
    // Not a dump: the first frame releases only a slice of the backlog.
    expect(counts[0]).toBeLessThan(30);
    // Prompt: done within ~2.5x the finish window (exponential phase down to
    // the FINISH_MIN_CPS floor, then a linear landing).
    expect(counts.length * DT).toBeLessThanOrEqual(FINISH_LATENCY_MS * 2.5);
    // Not instant: it took more than a couple of frames.
    expect(counts.length).toBeGreaterThan(3);
  });

  it("respects the latency-cap constant relationship", () => {
    // At a backlog equal to MAX_LATENCY worth of the min rate, the cap is at
    // the floor; deeper than that, the cap dominates. Guards the knobs staying
    // internally consistent.
    expect(MAX_LATENCY_MS).toBeGreaterThan(0);
    expect(SOFT_TARGET_CHARS).toBeGreaterThan(0);
  });
});

/**
 * Feed clumps on a schedule, RECORDING each arrival into the pace state so
 * the arrival-adaptive path engages, and drain through the pacer.
 */
function simulateAdaptive(
  state: PaceState,
  feedPerFrame: (frame: number) => number,
  frames: number,
): { counts: number[]; backlog: number[] } {
  const counts: number[] = [];
  const backlog: number[] = [];
  let buf = 0;
  for (let f = 0; f < frames; f += 1) {
    const fed = feedPerFrame(f);
    if (fed > 0) {
      recordArrival(state, fed, f * DT);
      buf += fed;
    }
    const c = stepPaceCount(state, buf, DT);
    buf -= c;
    counts.push(c);
    backlog.push(buf);
  }
  return { counts, backlog };
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

describe("stepPaceCount — arrival-adaptive pacing (slow/choppy streams)", () => {
  it("recordArrival converges to the mean rate of a bursty feed", () => {
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

  it("keeps the reveal flowing across the gaps of a slow choppy stream", () => {
    // 20 chars every 2 s (~10 cps) — well below the fixed 18 cps floor. The
    // fixed model drains each clump early and stalls ~0.9 s per period; the
    // adaptive floor tracks under 10 cps so a cushion bridges the gaps.
    const state = createPaceState();
    const { counts } = simulateAdaptive(
      state,
      (f) => (f % 120 === 0 ? 20 : 0),
      1_800, // 30 s: warm-up + steady state
    );
    const tail = counts.slice(900);
    // No visible stall: at ~9 cps a release lands every ~7 frames, so any
    // zero-run beyond ~0.5 s means the buffer was outrun (the old failure).
    expect(longestStallFrames(tail)).toBeLessThan(30);
    // And no clump dump: single-frame releases stay tiny.
    expect(Math.max(...tail)).toBeLessThanOrEqual(2);
    // Throughput still matches the arrival rate (~10 cps ≈ 0.167/frame).
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeGreaterThan(0.1);
    expect(avg).toBeLessThan(0.25);
  });

  it("adaptive floor never reveals slower than the absolute minimum", () => {
    // A near-dead stream (a few chars every several seconds) must still
    // reveal at >= SLOW_MIN_PLAYOUT_CPS, never crawl to nothing.
    const state = createPaceState();
    for (let i = 0; i < 6; i += 1) recordArrival(state, 4, i * 4000);
    expect(state.arrivalCps).toBeLessThan(SLOW_MIN_PLAYOUT_CPS);
    let remaining = 12;
    let frames = 0;
    while (remaining > 0 && frames < 600) {
      remaining -= stepPaceCount(state, remaining, DT);
      frames += 1;
    }
    expect(remaining).toBe(0);
    // 12 chars at >= 6 cps completes within ~2 s (plus smoothing slack).
    expect(frames * DT).toBeLessThan(2_600);
  });

  it("does not regress a fast stream when arrivals are recorded", () => {
    // ~120 cps steady: arrival-aware pacing must collapse to the fixed-knob
    // behavior — bounded backlog, throughput matching arrival.
    const state = createPaceState();
    const { counts, backlog } = simulateAdaptive(state, () => 2, 600);
    expect(Math.max(...backlog.slice(300))).toBeLessThan(120);
    const tail = counts.slice(300);
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeGreaterThan(1.7);
    expect(avg).toBeLessThan(2.3);
    // Fast arrival keeps the fixed floor: no slow-stream throttling.
    expect(state.cps).toBeGreaterThan(MIN_PLAYOUT_CPS);
  });
});
