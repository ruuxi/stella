import { useEffect, useState, type RefObject } from "react";

/**
 * Track whether an element has ever come into view via
 * `IntersectionObserver`. Once seen, the hook stays `true` so callers
 * can mount heavy children on first reveal without tearing them down
 * when the user scrolls slightly off-screen and back.
 *
 * Returns `true` immediately on environments without
 * `IntersectionObserver` (older renderers / tests) so callers fall
 * back to eager mounting rather than blocking forever.
 */
export const useHasBeenVisible = (
  ref: RefObject<HTMLElement | null>,
  rootMargin = "200px",
): boolean => {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setSeen(true);
            observer.disconnect();
            return;
          }
        }
      },
      { rootMargin, threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, rootMargin, seen]);
  return seen;
};
