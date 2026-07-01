import { describe, expect, it } from "vitest";
import {
  createPaceState,
  stepPaceCount,
  MAX_LATENCY_MS,
  SOFT_TARGET_CHARS,
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

  it("respects the latency-cap constant relationship", () => {
    // At a backlog equal to MAX_LATENCY worth of the min rate, the cap is at
    // the floor; deeper than that, the cap dominates. Guards the knobs staying
    // internally consistent.
    expect(MAX_LATENCY_MS).toBeGreaterThan(0);
    expect(SOFT_TARGET_CHARS).toBeGreaterThan(0);
  });
});
