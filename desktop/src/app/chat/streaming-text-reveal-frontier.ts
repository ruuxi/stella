/** Pure frame math for the streaming assistant's soft reveal mask. */

/** Width of the transparent fade at the reveal frontier. */
export const FADE_WIDTH = 48;
/** Per-frame proportional catch-up toward the measured caret. */
const CATCH_UP = 0.22;
/** Minimum frontier speed (px/frame) so short deltas still glide. */
const MIN_SPEED = 1.5;
/** Vertical tolerance when deciding whether two rects share a line. */
const LINE_EPSILON = 2;
/** Finish a half-faded tail when visible text has stopped moving. */
export const IDLE_FINISH_MS = 400;

export interface RevealState {
  initialized: boolean;
  lineTop: number;
  lineBottom: number;
  /** Frontier x within the wrapper (mask gradient endpoint). */
  x: number;
  /** Rightmost caret x observed on the active reveal line. */
  maxRight: number;
  /** Last time the rendered caret advanced. */
  lastProgressAtMs: number;
}

export const createRevealState = (): RevealState => ({
  initialized: false,
  lineTop: 0,
  lineBottom: 0,
  x: 0,
  maxRight: 0,
  lastProgressAtMs: 0,
});

export interface RevealCaret {
  top: number;
  bottom: number;
  right: number;
}

function stepFrontierX(state: RevealState, goal: number, accel: number): void {
  if (state.x >= goal) return;
  state.x = Math.min(
    goal,
    state.x +
      Math.max((goal - state.x) * CATCH_UP * accel, MIN_SPEED * accel),
  );
}

/**
 * Move the mask toward the rendered caret without ever skipping wrapped
 * lines. Returns true only after an ended stream's final fade is fully clear.
 */
export function advanceRevealFrontier(
  state: RevealState,
  caret: RevealCaret,
  active: boolean,
  nowMs: number,
  lineRight: number = caret.right,
): boolean {
  if (!state.initialized || caret.bottom < state.lineTop - LINE_EPSILON) {
    const movedUp = state.initialized;
    state.initialized = true;
    state.lineTop = caret.top;
    state.lineBottom = caret.bottom;
    state.x = movedUp ? caret.right : 0;
    state.maxRight = caret.right;
    state.lastProgressAtMs = nowMs;
  }

  const lineHeight = Math.max(1, state.lineBottom - state.lineTop);
  const sameLine = caret.top < state.lineBottom - LINE_EPSILON;
  const finishTail =
    !active || nowMs - state.lastProgressAtMs >= IDLE_FINISH_MS;

  if (sameLine) {
    state.lineTop = Math.min(state.lineTop, caret.top);
    state.lineBottom = Math.max(state.lineBottom, caret.bottom);
    if (caret.right > state.maxRight + 0.5) {
      state.lastProgressAtMs = nowMs;
    }
    state.maxRight = Math.max(state.maxRight, caret.right);
    const goal = finishTail ? caret.right + FADE_WIDTH : caret.right;
    stepFrontierX(state, goal, 1);
    return !active && state.x >= caret.right + FADE_WIDTH - 0.5;
  }

  // A burst may move the DOM caret several lines at once. Sweep each line
  // before advancing vertically so intermediate text never appears as a dump.
  const linesBehind = Math.max(
    1,
    Math.round((caret.top - state.lineTop) / lineHeight),
  );
  const currentLineRight = Math.max(state.maxRight, lineRight);
  stepFrontierX(state, currentLineRight + FADE_WIDTH, linesBehind);
  if (state.x >= currentLineRight + FADE_WIDTH - 0.5) {
    const nextBottom = state.lineBottom + lineHeight;
    state.x = 0;
    if (caret.top < nextBottom - LINE_EPSILON) {
      state.lineTop = caret.top;
      state.lineBottom = caret.bottom;
      state.maxRight = caret.right;
      state.lastProgressAtMs = nowMs;
    } else {
      state.lineTop = state.lineBottom;
      state.lineBottom = nextBottom;
      state.maxRight = lineRight;
    }
  }

  return false;
}
