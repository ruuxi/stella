/**
 * Mask geometry for `StreamingTextReveal` — the code-block chrome lookup
 * and the pure layer math for the reveal mask. Kept out of the component
 * file so the math is unit-testable (and Fast Refresh keeps a
 * components-only module), mirroring `streaming-text-reveal-frontier.ts`.
 */

import { FADE_WIDTH, type RevealState } from "./streaming-text-reveal-frontier";

/** Outer streamdown code-block card. */
export const CODE_BLOCK_CARD_SELECTOR = '[data-streamdown="code-block"]';

/**
 * Bottom of the code-block container the caret currently sits inside,
 * in container-relative px, or `null` when the caret is in plain prose.
 *
 * A fenced code block carries its own chrome — card padding + border +
 * rounded-bottom corners — *below* the last code line. The reveal mask
 * clips everything beneath the caret line, so during streaming that
 * structural chrome (and visually the bottom of the last line) gets cut
 * off at the block's edge. The caret is always the deepest *last* visible
 * node, so nothing renders below it except this chrome; extending the
 * revealed region down to the block's bottom restores it without exposing
 * any not-yet-revealed text.
 *
 * Resolve to the OUTER streamdown card first — its chrome (≈8px padding,
 * border, rounded-bottom corners, `bg-sidebar`) sits below the inner
 * `<pre>`. `closest()` returns the *nearest* matching ancestor regardless
 * of selector order, so a `'[data-streamdown="code-block"], pre'` union
 * would always resolve to the inner `<pre>` and leave that outer ring
 * clipped. Two separate `closest()` calls give us the card when present
 * and fall back to a bare `<pre>` only for code not wrapped in the card
 * (e.g. indented code blocks).
 */
export function findCodeBlockBottom(
  last: Node,
  container: HTMLElement,
  containerTop: number,
): number | null {
  const start =
    last.nodeType === Node.TEXT_NODE
      ? last.parentElement
      : (last as Element);
  if (!start) return null;
  const block =
    start.closest(CODE_BLOCK_CARD_SELECTOR) ?? start.closest("pre");
  if (!block || !container.contains(block)) return null;
  return block.getBoundingClientRect().bottom - containerTop;
}

/** Resolved CSS values for the multi-layer reveal mask. */
export interface RevealMaskStyle {
  maskImage: string;
  maskSize: string;
  maskPosition: string;
  maskRepeat: string;
}

/**
 * Build the layered reveal mask:
 *   layer 1 — everything above the caret line: fully opaque
 *   layer 2 — the caret line: opaque → transparent gradient at the frontier
 *   layer 3 — code-block chrome below the actual last line: fully opaque
 *
 * Layer 3 is anchored to the measured caret bottom (not the lagging
 * `state.lineBottom`) so intermediate, not-yet-revealed lines stay hidden
 * while the frontier sweeps toward them — preserving the line-by-line
 * typewriter effect. For plain prose `clipBottom` collapses to the caret
 * line bottom, the band height is `<= 0`, and no third layer is emitted.
 */
export function buildRevealMask(
  state: RevealState,
  caretBottom: number,
  clipBottom: number,
): RevealMaskStyle {
  const lineHeight = Math.max(1, state.lineBottom - state.lineTop);
  const images = [
    "linear-gradient(#000, #000)",
    `linear-gradient(to right, #000 ${Math.max(0, state.x - FADE_WIDTH)}px, transparent ${state.x}px)`,
  ];
  const sizes = [
    `100% ${Math.max(0, state.lineTop)}px`,
    `100% ${lineHeight}px`,
  ];
  const positions = ["0 0", `0 ${state.lineTop}px`];
  const chromeTop = Math.max(state.lineBottom, caretBottom);
  const chromeHeight = clipBottom - chromeTop;
  if (chromeHeight > 0) {
    images.push("linear-gradient(#000, #000)");
    sizes.push(`100% ${chromeHeight}px`);
    positions.push(`0 ${chromeTop}px`);
  }
  return {
    maskImage: images.join(", "),
    maskSize: sizes.join(", "),
    maskPosition: positions.join(", "),
    maskRepeat: images.map(() => "no-repeat").join(", "),
  };
}
