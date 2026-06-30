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
 *
 * The per-frame frontier math (including the caret-stall finish that
 * keeps the tail from sitting half-faded while tool-call args stream
 * invisibly) lives in `streaming-text-reveal-frontier.ts`.
 */
import { useEffect, useRef, type ReactNode } from "react";
import {
  advanceRevealFrontier,
  createRevealState,
  type RevealState,
} from "./streaming-text-reveal-frontier";
import {
  buildRevealMask,
  findCodeBlockBottom,
} from "./streaming-text-reveal-mask";

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
function measureCaretRect(last: Node): DOMRect | null {
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
  caretBottom: number,
  clipBottom: number,
): void {
  const mask = buildRevealMask(state, caretBottom, clipBottom);
  el.style.maskImage = mask.maskImage;
  el.style.maskSize = mask.maskSize;
  el.style.maskPosition = mask.maskPosition;
  el.style.maskRepeat = mask.maskRepeat;
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
  const stateRef = useRef<RevealState>(createRevealState());
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

      const lastNode = findLastVisibleNode(el);
      const caret = lastNode ? measureCaretRect(lastNode) : null;
      if (!caret || !lastNode) {
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
      const caughtUp = advanceRevealFrontier(
        state,
        {
          top: caret.top - containerRect.top,
          bottom: caret.bottom - containerRect.top,
          right: caret.right - containerRect.left,
        },
        activeRef.current,
        Date.now(),
      );

      if (caughtUp) {
        clearMask(el);
        state.initialized = false;
        state.x = 0;
        frameRef.current = null;
        return;
      }

      const caretBottom = caret.bottom - containerRect.top;
      const codeBlockBottom = findCodeBlockBottom(
        lastNode,
        el,
        containerRect.top,
      );
      const clipBottom =
        codeBlockBottom !== null
          ? Math.max(state.lineBottom, caretBottom, codeBlockBottom)
          : state.lineBottom;
      applyMask(el, state, caretBottom, clipBottom);
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
