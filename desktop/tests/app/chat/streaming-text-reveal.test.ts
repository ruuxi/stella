import { describe, expect, it } from "vitest";
import {
  advanceRevealFrontier,
  createRevealState,
  FADE_WIDTH,
  IDLE_FINISH_MS,
  type RevealCaret,
} from "@/app/chat/streaming-text-reveal-frontier";

const runFrames = (
  state: ReturnType<typeof createRevealState>,
  caret: RevealCaret,
  active: boolean,
  nowMs: number,
  frames = 200,
  lineRight = caret.right,
): boolean => {
  let caughtUp = false;
  for (let frame = 0; frame < frames && !caughtUp; frame += 1) {
    caughtUp = advanceRevealFrontier(
      state,
      caret,
      active,
      nowMs,
      lineRight,
    );
  }
  return caughtUp;
};

describe("advanceRevealFrontier", () => {
  it("glides to the live caret and finishes the final soft tail", () => {
    const state = createRevealState();
    const caret = { top: 0, bottom: 20, right: 220 };

    runFrames(state, caret, true, 0);
    expect(state.x).toBe(220);

    const caughtUp = runFrames(state, caret, false, 100);
    expect(caughtUp).toBe(true);
    expect(state.x).toBe(220 + FADE_WIDTH);
  });

  it("finishes a half-faded tail after visible text stalls", () => {
    const state = createRevealState();
    const caret = { top: 0, bottom: 20, right: 180 };
    runFrames(state, caret, true, 0);

    runFrames(state, caret, true, IDLE_FINISH_MS + 1);
    expect(state.x).toBe(180 + FADE_WIDTH);
  });

  it("visits every wrapped line when a burst moves the caret", () => {
    const state = createRevealState();
    runFrames(state, { top: 0, bottom: 20, right: 200 }, true, 0);

    const caret = { top: 80, bottom: 100, right: 120 };
    const seen = new Set<number>();
    for (let frame = 0; frame < 200; frame += 1) {
      advanceRevealFrontier(state, caret, true, 10, 600);
      seen.add(state.lineTop);
    }

    expect(seen).toEqual(new Set([0, 20, 40, 60, 80]));
    expect(state.x).toBe(120);
  });
});
