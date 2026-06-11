/**
 * Pure frontier math for `StreamingTextReveal` — one frame of the
 * left-to-right mask reveal. Kept out of the component file so the
 * stall/finish behavior is unit-testable (and Fast Refresh keeps a
 * components-only module).
 */

/** Width of the transparent fade at the reveal frontier. */
export const FADE_WIDTH = 48;
/** Per-frame proportional catch-up toward the measured caret. */
const CATCH_UP = 0.22;
/** Minimum frontier speed (px/frame) so short deltas still glide. */
const MIN_SPEED = 1.5;
/** Vertical tolerance when deciding "same line" across reflows. */
const LINE_EPSILON = 2;
/**
 * Caret-stall window after which the tail finishes its fade even though
 * the row is still streaming. A run can stop producing *visible* text
 * long before it stops streaming — most commonly when the model moves on
 * to tool-call arguments, which stream for seconds without rendering
 * anything — and without this the last words would sit half-faded inside
 * the gradient ramp for that whole window.
 */
export const IDLE_FINISH_MS = 400;

export interface RevealState {
  initialized: boolean;
  lineTop: number;
  lineBottom: number;
  /** Frontier x within the container (mask gradient endpoint). */
  x: number;
  /** Rightmost caret x observed on the current line (line-finish goal). */
  maxRight: number;
  /** Last time the caret advanced (new text painted). */
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

/** Container-relative rect of the last rendered line box. */
export interface RevealCaret {
  top: number;
  bottom: number;
  right: number;
}

/**
 * Advance the reveal frontier by one frame toward the measured caret.
 * Mutates `state`. Returns `true` when the reveal fully caught up after
 * streaming ended — the caller should clear the mask and stop ticking.
 */
export function advanceRevealFrontier(
  state: RevealState,
  caret: RevealCaret,
  active: boolean,
  nowMs: number,
): boolean {
  if (!state.initialized || caret.bottom < state.lineTop - LINE_EPSILON) {
    // First measurement → sweep in from the left; a relayout that
    // moved content upward → snap to the caret (no replay).
    const movedUp = state.initialized;
    state.initialized = true;
    state.lineTop = caret.top;
    state.lineBottom = caret.bottom;
    state.x = movedUp ? caret.right : 0;
    state.maxRight = caret.right;
    state.lastProgressAtMs = nowMs;
  }

  const sameLine = caret.top < state.lineBottom - LINE_EPSILON;
  // Once the caret stalls (no new visible text — e.g. the model is
  // streaming tool-call args we never render), finish the tail instead
  // of holding the last words half-faded in the gradient ramp.
  const finishTail =
    !active || nowMs - state.lastProgressAtMs >= IDLE_FINISH_MS;
  let goal: number;
  if (sameLine) {
    state.lineTop = Math.min(state.lineTop, caret.top);
    state.lineBottom = Math.max(state.lineBottom, caret.bottom);
    if (caret.right > state.maxRight + 0.5) {
      state.lastProgressAtMs = nowMs;
    }
    state.maxRight = Math.max(state.maxRight, caret.right);
    // While text is arriving, glide up to the caret; once the stream
    // ends or stalls, overshoot by the fade width so the tail reaches
    // full opacity.
    goal = finishTail ? caret.right + FADE_WIDTH : caret.right;
  } else {
    // Caret wrapped to a lower line: finish sweeping the current
    // line past its recorded end, then latch onto the new line.
    goal = state.maxRight + FADE_WIDTH;
    if (state.x >= goal - 0.5) {
      state.lineTop = caret.top;
      state.lineBottom = caret.bottom;
      state.x = 0;
      state.maxRight = caret.right;
      state.lastProgressAtMs = nowMs;
      goal = !active ? caret.right + FADE_WIDTH : caret.right;
    }
  }

  if (state.x < goal) {
    state.x = Math.min(
      goal,
      state.x + Math.max((goal - state.x) * CATCH_UP, MIN_SPEED),
    );
  }

  return sameLine && !active && state.x >= caret.right + FADE_WIDTH - 0.5;
}
