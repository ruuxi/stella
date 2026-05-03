import { useEffect, useRef, type RefObject } from "react";

type EdgeFadeAxis = "horizontal" | "vertical";

type EdgeFadeOptions = {
  /**
   * Which scroll axis to track. Defaults to `"horizontal"` since most
   * tab strips are horizontal — vertical scrollers should opt in.
   */
  axis?: EdgeFadeAxis;
};

/**
 * Tracks whether a scrollable element is at its start / end on the
 * given axis and reflects that as `data-at-start` / `data-at-end`
 * boolean attributes on the element. Pair with CSS that drops the
 * fade mask on the corresponding side so the mask only ever applies
 * where there's actually more content to scroll towards (otherwise
 * a visible item against an empty edge looks incorrectly faded out).
 *
 * Listens to `scroll` + size of the element via `ResizeObserver`,
 * and a window resize as a backstop for layout-only changes.
 */
export function useEdgeFade<T extends HTMLElement>(
  ref: RefObject<T | null>,
  { axis = "horizontal" }: EdgeFadeOptions = {},
): void {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const TOLERANCE = 1;

    const update = () => {
      const max =
        axis === "horizontal"
          ? node.scrollWidth - node.clientWidth
          : node.scrollHeight - node.clientHeight;
      // No overflow at all on this axis — neither edge has anything
      // past it; treat both edges as "at edge" so the mask is fully
      // removed by the CSS rule.
      if (max <= TOLERANCE) {
        node.dataset.atStart = "true";
        node.dataset.atEnd = "true";
        return;
      }
      const offset =
        axis === "horizontal" ? node.scrollLeft : node.scrollTop;
      node.dataset.atStart = offset <= TOLERANCE ? "true" : "false";
      node.dataset.atEnd = offset >= max - TOLERANCE ? "true" : "false";
    };

    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    window.addEventListener("resize", update);

    return () => {
      node.removeEventListener("scroll", update);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [ref, axis]);
}

/**
 * Convenience wrapper for the common case of "I just need a ref to
 * stick on a single scroller". Returns the ref directly.
 */
export function useEdgeFadeRef<T extends HTMLElement>(
  options?: EdgeFadeOptions,
) {
  const ref = useRef<T | null>(null);
  useEdgeFade(ref, options);
  return ref;
}
