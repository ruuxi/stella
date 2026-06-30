import { describe, expect, it } from "vitest";
import {
  advanceRevealFrontier,
  createRevealState,
  IDLE_FINISH_MS,
  type RevealCaret,
} from "@/app/chat/streaming-text-reveal-frontier";

const FADE_WIDTH = 48;

const line = (right: number): RevealCaret => ({ top: 0, bottom: 20, right });

const runFrames = (
  state: ReturnType<typeof createRevealState>,
  caret: RevealCaret,
  active: boolean,
  nowMs: number,
  frames: number,
): boolean => {
  let caughtUp = false;
  for (let frame = 0; frame < frames; frame += 1) {
    caughtUp = advanceRevealFrontier(state, caret, active, nowMs);
    if (caughtUp) break;
  }
  return caughtUp;
};

describe("advanceRevealFrontier", () => {
  it("glides toward the caret but stops there while text is arriving", () => {
    const state = createRevealState();
    runFrames(state, line(200), true, 0, 200);
    expect(state.x).toBe(200);

    // Caret advances → frontier follows, still parking at the caret.
    runFrames(state, line(260), true, 100, 200);
    expect(state.x).toBe(260);
  });

  it("finishes the tail fade when the caret stalls while still streaming (tool-call args)", () => {
    const state = createRevealState();
    runFrames(state, line(200), true, 0, 200);
    expect(state.x).toBe(200);

    // Visible text stops (model is streaming tool-call args we never
    // render). Before the idle window elapses the frontier holds...
    runFrames(state, line(200), true, IDLE_FINISH_MS - 50, 200);
    expect(state.x).toBe(200);

    // ...and once it elapses, the tail overshoots to full opacity even
    // though the row is still streaming.
    runFrames(state, line(200), true, IDLE_FINISH_MS + 1, 200);
    expect(state.x).toBe(200 + FADE_WIDTH);
  });

  it("resumes following the caret when text arrives after an idle finish", () => {
    const state = createRevealState();
    runFrames(state, line(200), true, 0, 200);
    runFrames(state, line(200), true, IDLE_FINISH_MS + 1, 200);
    expect(state.x).toBe(200 + FADE_WIDTH);

    // Post-stall text on the same line: progress timestamp refreshes, the
    // frontier keeps sweeping toward the new caret.
    const resumeAt = IDLE_FINISH_MS + 100;
    runFrames(state, line(400), true, resumeAt, 200);
    expect(state.x).toBe(400);
    expect(state.lastProgressAtMs).toBe(resumeAt);
  });

  it("overshoots and reports caught-up once the stream ends", () => {
    const state = createRevealState();
    runFrames(state, line(200), true, 0, 200);
    expect(state.x).toBe(200);

    const caughtUp = runFrames(state, line(200), false, 100, 200);
    expect(caughtUp).toBe(true);
    expect(state.x).toBe(200 + FADE_WIDTH);
  });

  it("sweeps out the previous line before latching onto a wrapped line", () => {
    const state = createRevealState();
    runFrames(state, line(200), true, 0, 200);

    // Caret wrapped to a lower line: finish the recorded line first.
    const wrapped: RevealCaret = { top: 24, bottom: 44, right: 120 };
    advanceRevealFrontier(state, wrapped, true, 50);
    expect(state.lineTop).toBe(0);
    expect(state.x).toBeGreaterThan(200);

    runFrames(state, wrapped, true, 60, 200);
    expect(state.lineTop).toBe(24);
    expect(state.x).toBe(120);
  });

  it("cascades line-by-line through a multi-line burst instead of dumping", () => {
    const state = createRevealState();
    // Reveal line 0 fully.
    runFrames(state, line(200), true, 0, 200);
    expect(state.x).toBe(200);

    // A burst lands: the caret jumps four lines down in a single frame
    // (lineHeight 20 → top 80). The reveal must NOT jump straight to the
    // caret's line — it visits each intermediate line in turn.
    const caret: RevealCaret = { top: 80, bottom: 100, right: 140 };
    const lineRight = 600;
    const seenLineTops = new Set<number>();
    let caughtUp = false;
    for (let frame = 0; frame < 200 && !caughtUp; frame += 1) {
      caughtUp = advanceRevealFrontier(state, caret, true, 10, lineRight);
      seenLineTops.add(state.lineTop);
    }
    // Every intermediate line (0, 20, 40, 60) plus the caret line (80)
    // was the active reveal line at some point — none were skipped.
    expect(seenLineTops.has(0)).toBe(true);
    expect(seenLineTops.has(20)).toBe(true);
    expect(seenLineTops.has(40)).toBe(true);
    expect(seenLineTops.has(60)).toBe(true);
    expect(state.lineTop).toBe(80);
    // Settles onto the caret's own line and parks at the live caret.
    expect(state.x).toBe(140);
  });

  it("keeps pace: a deep backlog catches up fast, then eases into the caret", () => {
    const state = createRevealState();
    runFrames(state, line(200), true, 0, 200);

    // Caret eight lines below in a single frame (a flush-sized jump).
    const caret: RevealCaret = { top: 160, bottom: 180, right: 90 };

    // The bulk of the backlog clears fast: within a handful of frames the
    // reveal has already advanced several lines (no multi-second crawl,
    // the failure mode of a naive gentle line-by-line sweep).
    for (let frame = 0; frame < 8; frame += 1) {
      advanceRevealFrontier(state, caret, true, 10, 600);
    }
    expect(state.lineTop).toBeGreaterThanOrEqual(80);

    // It still converges all the way onto the live caret line and parks
    // there — never overshooting or skipping it.
    let frames = 8;
    while (state.lineTop !== 160 && frames < 200) {
      advanceRevealFrontier(state, caret, true, 10, 600);
      frames += 1;
    }
    expect(state.lineTop).toBe(160);
    // Once on the caret's own line it glides up to and parks at the live
    // caret edge.
    runFrames(state, caret, true, 10, 200);
    expect(state.x).toBe(90);
  });
});
