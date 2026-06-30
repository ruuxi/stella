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
 * Advance the frontier `x` toward `goal` by one frame. `accel` (>= 1)
 * scales both the proportional catch-up and the floor speed so the
 * reveal can cascade quickly when it has fallen multiple lines behind a
 * burst, without ever overshooting the goal.
 */
function stepFrontierX(state: RevealState, goal: number, accel: number): void {
  if (state.x >= goal) return;
  state.x = Math.min(
    goal,
    state.x +
      Math.max((goal - state.x) * CATCH_UP * accel, MIN_SPEED * accel),
  );
}

/**
 * Advance the reveal frontier by one frame toward the measured caret.
 * Mutates `state`. Returns `true` when the reveal fully caught up after
 * streaming ended — the caller should clear the mask and stop ticking.
 *
 * `lineRight` is the full text-column width (container-relative): the
 * right edge an intermediate, fully-wrapped line is swept to while the
 * frontier cascades down toward a caret several lines below. Defaults to
 * the caret's own right edge so single-line callers/tests need not pass
 * it.
 */
export function advanceRevealFrontier(
  state: RevealState,
  caret: RevealCaret,
  active: boolean,
  nowMs: number,
  lineRight: number = caret.right,
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

  const lineHeight = Math.max(1, state.lineBottom - state.lineTop);
  const sameLine = caret.top < state.lineBottom - LINE_EPSILON;
  // Once the caret stalls (no new visible text — e.g. the model is
  // streaming tool-call args we never render), finish the tail instead
  // of holding the last words half-faded in the gradient ramp.
  const finishTail =
    !active || nowMs - state.lastProgressAtMs >= IDLE_FINISH_MS;

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
    const goal = finishTail ? caret.right + FADE_WIDTH : caret.right;
    stepFrontierX(state, goal, 1);
    return !active && state.x >= caret.right + FADE_WIDTH - 0.5;
  }

  // Caret wrapped below the current reveal line. Sweep the current line
  // to its full end, then step DOWN exactly one line — never jump
  // straight to the caret's latest line, which would expose every
  // intermediate line at once (the "stall then dump a whole paragraph"
  // jank). Accelerate proportional to how far behind the reveal is so a
  // multi-line burst cascades quickly but still line-by-line, keeping
  // pace with the stream instead of crawling one slow line at a time.
  const linesBehind = Math.max(
    1,
    Math.round((caret.top - state.lineTop) / lineHeight),
  );
  // A line the caret has already moved past is complete and fills the
  // text column; reveal it to the wider of its measured end and the
  // full column width.
  const currentLineRight = Math.max(state.maxRight, lineRight);
  stepFrontierX(state, currentLineRight + FADE_WIDTH, linesBehind);
  if (state.x >= currentLineRight + FADE_WIDTH - 0.5) {
    const nextBottom = state.lineBottom + lineHeight;
    state.x = 0;
    if (caret.top < nextBottom - LINE_EPSILON) {
      // The next line down is the caret's own line → adopt its real
      // geometry so the final sweep tracks the live caret.
      state.lineTop = caret.top;
      state.lineBottom = caret.bottom;
      state.maxRight = caret.right;
      state.lastProgressAtMs = nowMs;
    } else {
      // An intermediate fully-wrapped line → advance arithmetically and
      // reveal it at the full column width.
      state.lineTop = state.lineBottom;
      state.lineBottom = nextBottom;
      state.maxRight = lineRight;
    }
  }

  return false;
}
