import { FADE_WIDTH, type RevealState } from "./streaming-text-reveal-frontier";

export const CODE_BLOCK_CARD_SELECTOR = '[data-streamdown="code-block"]';

/** Return code-block chrome's wrapper-relative bottom, when applicable. */
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

export interface RevealMaskStyle {
  maskImage: string;
  maskSize: string;
  maskPosition: string;
  maskRepeat: string;
}

/** Build the opaque-above + soft-horizontal-frontier mask layers. */
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
