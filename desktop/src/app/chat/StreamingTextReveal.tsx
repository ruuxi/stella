/**
 * Left-to-right transparent mask reveal for streaming assistant text.
 *
 * Why a mask instead of per-word/per-character animation: Streamdown
 * re-parses and re-mounts the active markdown block on every chunk, so
 * any animation keyed to DOM mount (span fade-ins, etc.) restarts for
 * words that already exist — the classic "previous words re-animate"
 * bug. Here the animation lives entirely on a stable wrapper element:
 * a two-layer CSS mask where
 *
 *   layer 1 — everything above the current line: fully opaque
 *   layer 2 — the current line: opaque → transparent horizontal
 *             gradient at the reveal frontier
 *
 * and everything below the current line is outside both layers (hidden).
 * A rAF loop measures where the rendered text currently ends and lerps
 * the frontier toward it, advancing monotonically. Because no state is
 * attached to the text DOM, Streamdown can replace nodes freely without
 * ever re-triggering the reveal.
 */
import { useEffect, useRef, type ReactNode } from "react";

/** Width of the transparent fade at the reveal frontier. */
const FADE_WIDTH = 48;
/** Per-frame proportional catch-up toward the measured caret. */
const CATCH_UP = 0.22;
/** Minimum frontier speed (px/frame) so short deltas still glide. */
const MIN_SPEED = 1.5;
/** Vertical tolerance when deciding "same line" across reflows. */
const LINE_EPSILON = 2;

interface RevealState {
  initialized: boolean;
  lineTop: number;
  lineBottom: number;
  /** Frontier x within the container (mask gradient endpoint). */
  x: number;
  /** Rightmost caret x observed on the current line (line-finish goal). */
  maxRight: number;
}

/**
 * Deepest last visible node — the live caret position lives at its
 * trailing edge. Skips whitespace-only text nodes and zero-rect elements
 * (e.g. display:none plugin artifacts).
 */
function findLastVisibleNode(parent: Node): Node | null {
  for (let i = parent.childNodes.length - 1; i >= 0; i -= 1) {
    const child = parent.childNodes[i];
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").trim().length > 0) return child;
      continue;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      if (el.getClientRects().length === 0) continue;
      const inner = findLastVisibleNode(child);
      return inner ?? el;
    }
  }
  return null;
}

/** Rect of the last rendered line box (viewport coordinates). */
function measureCaretRect(container: HTMLElement): DOMRect | null {
  const last = findLastVisibleNode(container);
  if (!last) return null;
  if (last.nodeType === Node.TEXT_NODE) {
    const range = document.createRange();
    range.selectNodeContents(last);
    const rects = range.getClientRects();
    return rects.length > 0 ? rects[rects.length - 1] : null;
  }
  const rects = (last as HTMLElement).getClientRects();
  return rects.length > 0 ? rects[rects.length - 1] : null;
}

function applyMask(
  el: HTMLElement,
  state: RevealState,
): void {
  const lineHeight = Math.max(1, state.lineBottom - state.lineTop);
  el.style.maskImage = `linear-gradient(#000, #000), linear-gradient(to right, #000 ${Math.max(0, state.x - FADE_WIDTH)}px, transparent ${state.x}px)`;
  el.style.maskSize = `100% ${Math.max(0, state.lineTop)}px, 100% ${lineHeight}px`;
  el.style.maskPosition = `0 0, 0 ${state.lineTop}px`;
  el.style.maskRepeat = "no-repeat, no-repeat";
}

function clearMask(el: HTMLElement): void {
  el.style.maskImage = "";
  el.style.maskSize = "";
  el.style.maskPosition = "";
  el.style.maskRepeat = "";
}

interface StreamingTextRevealProps {
  /** True while the row is receiving stream chunks. */
  active: boolean;
  children: ReactNode;
}

export function StreamingTextReveal({
  active,
  children,
}: StreamingTextRevealProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  const stateRef = useRef<RevealState>({
    initialized: false,
    lineTop: 0,
    lineBottom: 0,
    x: 0,
    maxRight: 0,
  });
  const frameRef = useRef<number | null>(null);

  activeRef.current = active;

  useEffect(() => {
    if (!active || frameRef.current !== null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const tick = () => {
      const el = ref.current;
      const state = stateRef.current;
      if (!el) {
        frameRef.current = null;
        return;
      }

      const caret = measureCaretRect(el);
      if (!caret) {
        // No measurable content yet — hold fully masked until the
        // first chunk paints, then reveal from the line's left edge.
        if (activeRef.current) {
          el.style.maskImage = "linear-gradient(transparent, transparent)";
          frameRef.current = requestAnimationFrame(tick);
        } else {
          clearMask(el);
          state.initialized = false;
          frameRef.current = null;
        }
        return;
      }

      const containerRect = el.getBoundingClientRect();
      const tTop = caret.top - containerRect.top;
      const tBottom = caret.bottom - containerRect.top;
      const tRight = caret.right - containerRect.left;

      if (!state.initialized || tBottom < state.lineTop - LINE_EPSILON) {
        // First measurement → sweep in from the left; a relayout that
        // moved content upward → snap to the caret (no replay).
        const movedUp = state.initialized;
        state.initialized = true;
        state.lineTop = tTop;
        state.lineBottom = tBottom;
        state.x = movedUp ? tRight : 0;
        state.maxRight = tRight;
      }

      const sameLine = tTop < state.lineBottom - LINE_EPSILON;
      let goal: number;
      if (sameLine) {
        state.lineTop = Math.min(state.lineTop, tTop);
        state.lineBottom = Math.max(state.lineBottom, tBottom);
        state.maxRight = Math.max(state.maxRight, tRight);
        // While streaming, glide up to the caret; once the stream ends,
        // overshoot by the fade width so the tail reaches full opacity.
        goal = activeRef.current ? tRight : tRight + FADE_WIDTH;
      } else {
        // Caret wrapped to a lower line: finish sweeping the current
        // line past its recorded end, then latch onto the new line.
        goal = state.maxRight + FADE_WIDTH;
        if (state.x >= goal - 0.5) {
          state.lineTop = tTop;
          state.lineBottom = tBottom;
          state.x = 0;
          state.maxRight = tRight;
          goal = activeRef.current ? tRight : tRight + FADE_WIDTH;
        }
      }

      if (state.x < goal) {
        state.x = Math.min(
          goal,
          state.x + Math.max((goal - state.x) * CATCH_UP, MIN_SPEED),
        );
      }

      const caughtUp =
        sameLine && !activeRef.current && state.x >= tRight + FADE_WIDTH - 0.5;
      if (caughtUp) {
        clearMask(el);
        state.initialized = false;
        state.x = 0;
        frameRef.current = null;
        return;
      }

      applyMask(el, state);
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
  }, [active]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    },
    [],
  );

  return <div ref={ref}>{children}</div>;
}
