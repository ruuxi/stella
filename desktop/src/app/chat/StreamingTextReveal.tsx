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
import { useNotifyAssistantTextPainted } from "./assistant-text-paint-context";
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

/** Fully-transparent hold mask shown before the first character paints. */
const HOLD_MASK_IMAGE = "linear-gradient(transparent, transparent)";
/** Sentinel stored in `lastKeyRef` once the mask has been cleared. */
const CLEARED_MASK_KEY = "";

type MaskKeyRef = { current: string | null };

/**
 * Apply the reveal mask, skipping the style write (and the layer
 * re-rasterization it forces) when the resulting mask is byte-identical to
 * what is already painted. The mask-image/size/position triple fully
 * determines the painted result, so a matching key means this frame would
 * paint exactly the same pixels — common when the frontier has caught up and
 * is idling between token bursts, or while the model streams tool-call args
 * that render no new visible text. Coalescing those frames keeps the reveal's
 * per-frame raster off the main thread so it stops competing with scroll
 * compositing, with zero change to what the user sees.
 */
function applyMask(
  el: HTMLElement,
  state: RevealState,
  caretBottom: number,
  clipBottom: number,
  lastKeyRef: MaskKeyRef,
): void {
  const mask = buildRevealMask(state, caretBottom, clipBottom);
  const key = `${mask.maskImage}|${mask.maskSize}|${mask.maskPosition}`;
  if (key === lastKeyRef.current) return;
  lastKeyRef.current = key;
  el.style.maskImage = mask.maskImage;
  el.style.maskSize = mask.maskSize;
  el.style.maskPosition = mask.maskPosition;
  el.style.maskRepeat = mask.maskRepeat;
}

/** Hold the row fully masked (pre-first-paint), deduped like `applyMask`. */
function applyHoldMask(el: HTMLElement, lastKeyRef: MaskKeyRef): void {
  if (lastKeyRef.current === HOLD_MASK_IMAGE) return;
  lastKeyRef.current = HOLD_MASK_IMAGE;
  el.style.maskImage = HOLD_MASK_IMAGE;
  el.style.maskSize = "";
  el.style.maskPosition = "";
  el.style.maskRepeat = "";
}

function clearMask(el: HTMLElement, lastKeyRef: MaskKeyRef): void {
  if (lastKeyRef.current === CLEARED_MASK_KEY) return;
  lastKeyRef.current = CLEARED_MASK_KEY;
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
  // Signature of the mask currently written to the DOM, so the rAF loop can
  // skip re-applying (and re-rasterizing) an unchanged mask frame-to-frame.
  const lastMaskKeyRef = useRef<string | null>(null);
  const notifyPainted = useNotifyAssistantTextPainted();
  const paintedRef = useRef(false);

  activeRef.current = active;

  // First-visible-paint signal. The working indicator stays up until the
  // assistant's first character is actually on screen, so it needs to know
  // the moment the reveal has measurable painted content — independent of
  // the mask animation (which `prefers-reduced-motion` disables). A cheap
  // rAF poll watches for the first measurable node, fires once, and stops.
  //
  // The signal fires once per reveal instance (`paintedRef` latches, and
  // resets only when `active` drops). That is enough to re-arm the
  // indicator hand-off after a `tool-start` clears `isStreamingText`: the
  // post-tool answer is structurally a *new* assistant message, so it lands
  // in a fresh overlay slot (a brand-new `StreamingTextReveal` instance with
  // `paintedRef` already false). The agent loop guarantees this ordering —
  // `message_end` (→ `ASSISTANT_MESSAGE` boundary → slot-index advance)
  // always precedes the next `tool_execution_start`, and text never resumes
  // inside an already-streamed message, so a second text segment can never
  // reuse this instance with a stale latched `paintedRef`.
  useEffect(() => {
    if (!active) {
      paintedRef.current = false;
      return;
    }
    if (paintedRef.current) return;
    let raf = 0;
    const check = () => {
      const el = ref.current;
      if (el && findLastVisibleNode(el)) {
        paintedRef.current = true;
        notifyPainted();
        return;
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [active, notifyPainted]);

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
          applyHoldMask(el, lastMaskKeyRef);
          frameRef.current = requestAnimationFrame(tick);
        } else {
          clearMask(el, lastMaskKeyRef);
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
        containerRect.width,
      );

      if (caughtUp) {
        clearMask(el, lastMaskKeyRef);
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
      applyMask(el, state, caretBottom, clipBottom, lastMaskKeyRef);
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
