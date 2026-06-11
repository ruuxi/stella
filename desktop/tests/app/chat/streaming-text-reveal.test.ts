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
});
