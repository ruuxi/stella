/**
 * Stable-wrapper mask for newly streamed assistant text.
 *
 * Streamdown can replace markdown nodes as syntax becomes complete, so the
 * animation cannot live on individual words. This wrapper measures the last
 * rendered line and moves a soft horizontal CSS-mask frontier toward it.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { notifyAssistantScrollFollowLayoutChange } from "@/shell/chat-scroll-follow";
import {
  advanceRevealFrontier,
  createRevealState,
  type RevealState,
} from "./streaming-text-reveal-frontier";
import {
  buildRevealMask,
  findCodeBlockBottom,
} from "./streaming-text-reveal-mask";

export const REVEAL_VISIBLE_BOTTOM_ATTR = "data-reveal-visible-bottom";

type VisibleBottomRef = { current: number | null };

function publishVisibleBottom(
  el: HTMLElement,
  value: number | null,
  lastRef: VisibleBottomRef,
): void {
  const rounded = value === null ? null : Math.max(0, Math.round(value));
  if (lastRef.current === rounded) return;
  lastRef.current = rounded;
  if (rounded === null) {
    el.removeAttribute(REVEAL_VISIBLE_BOTTOM_ATTR);
  } else {
    el.setAttribute(REVEAL_VISIBLE_BOTTOM_ATTR, String(rounded));
  }
  notifyAssistantScrollFollowLayoutChange();
}

function findLastVisibleNode(parent: Node): Node | null {
  for (let index = parent.childNodes.length - 1; index >= 0; index -= 1) {
    const child = parent.childNodes[index];
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").trim().length > 0) return child;
      continue;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const element = child as HTMLElement;
      if (element.getClientRects().length === 0) continue;
      return findLastVisibleNode(child) ?? element;
    }
  }
  return null;
}

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

const HOLD_MASK_IMAGE = "linear-gradient(transparent, transparent)";
const CLEARED_MASK_KEY = "";

type MaskKeyRef = { current: string | null };

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

type StreamingTextRevealProps = {
  active: boolean;
  children: ReactNode;
};

export function StreamingTextReveal({
  active,
  children,
}: StreamingTextRevealProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  const stateRef = useRef<RevealState>(createRevealState());
  const frameRef = useRef<number | null>(null);
  const lastMaskKeyRef = useRef<string | null>(null);
  const lastVisibleBottomRef = useRef<number | null>(null);

  activeRef.current = active;

  // Layout effect applies the hold mask before the first streamed character
  // can flash at full opacity. Subsequent movement stays imperative so React
  // markdown renders never reset the frontier.
  useLayoutEffect(() => {
    if (!active || frameRef.current !== null) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const initialElement = ref.current;
    if (initialElement) applyHoldMask(initialElement, lastMaskKeyRef);

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
        if (activeRef.current) {
          applyHoldMask(el, lastMaskKeyRef);
          publishVisibleBottom(el, 0, lastVisibleBottomRef);
          frameRef.current = requestAnimationFrame(tick);
        } else {
          clearMask(el, lastMaskKeyRef);
          publishVisibleBottom(el, null, lastVisibleBottomRef);
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
        performance.now(),
        containerRect.width,
      );

      if (caughtUp) {
        clearMask(el, lastMaskKeyRef);
        publishVisibleBottom(el, null, lastVisibleBottomRef);
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
        codeBlockBottom === null
          ? state.lineBottom
          : Math.max(state.lineBottom, caretBottom, codeBlockBottom);
      applyMask(el, state, caretBottom, clipBottom, lastMaskKeyRef);
      publishVisibleBottom(el, clipBottom, lastVisibleBottomRef);
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
