import { describe, expect, it } from "vitest";
import {
  createPaceState,
  stepPaceCount,
  MAX_CATCH_UP_FRAMES,
} from "@/features/chat/streaming/stream-text-pacer-cadence";

/** Drain a fixed backlog (no new input) and return the per-frame counts. */
function drain(backlog: number, maxFrames = 400): number[] {
  const state = createPaceState();
  const counts: number[] = [];
  let remaining = backlog;
  let frames = 0;
  while (remaining > 0 && frames < maxFrames) {
    const c = stepPaceCount(state, remaining);
    expect(c).toBeGreaterThanOrEqual(1);
    expect(c).toBeLessThanOrEqual(remaining);
    counts.push(c);
    remaining -= c;
    frames += 1;
  }
  return counts;
}

describe("stepPaceCount", () => {
  it("returns 0 for an empty backlog and never over-releases", () => {
    const s = createPaceState();
    expect(stepPaceCount(s, 0)).toBe(0);
    expect(stepPaceCount(s, 3)).toBeLessThanOrEqual(3);
  });

  it("ramps a burst up gradually instead of dumping it in one frame", () => {
    // The old pacer released ceil(60/6)=10 code points on the very first
    // frame of a 60-char clump; the eased rate starts well below that so the
    // reveal accelerates into the burst rather than lurching.
    const s = createPaceState();
    const first = stepPaceCount(s, 60);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThan(10);
  });

  it("holds a smooth, near-constant cadence under steady input", () => {
    // Feed a steady 4 code points/frame and confirm the release settles to
    // the input rate without swinging frame-to-frame.
    const s = createPaceState();
    let backlog = 0;
    const counts: number[] = [];
    for (let f = 0; f < 140; f += 1) {
      backlog += 4;
      const c = stepPaceCount(s, backlog);
      backlog -= c;
      counts.push(c);
    }
    const tail = counts.slice(80);
    // Steady state: consecutive frames differ by at most one code point.
    for (let i = 1; i < tail.length; i += 1) {
      expect(Math.abs(tail[i] - tail[i - 1])).toBeLessThanOrEqual(1);
    }
    // And it tracks the input rate rather than lagging or racing.
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeGreaterThan(3.5);
    expect(avg).toBeLessThan(4.5);
  });

  it("eases the tail down rather than stopping abruptly", () => {
    // Draining a fixed backlog should produce a monotonic-ish wind-down, not
    // a full-speed burst followed by a hard stop.
    const counts = drain(60);
    const peak = Math.max(...counts);
    const last = counts[counts.length - 1];
    expect(last).toBeLessThanOrEqual(peak);
    // No single frame released the whole clump.
    expect(peak).toBeLessThan(60);
  });

  it("drains a fixed backlog within the latency ceiling", () => {
    // The hard floor keyed off MAX_CATCH_UP_FRAMES keeps the buffer from
    // lagging meaningfully even though the rate is eased.
    expect(drain(42).length).toBeLessThanOrEqual(MAX_CATCH_UP_FRAMES + 6);
  });

  it("never stalls while characters remain", () => {
    expect(drain(500).every((c) => c >= 1)).toBe(true);
  });
});
