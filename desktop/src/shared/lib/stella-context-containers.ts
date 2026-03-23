/** Semantic boundary tags that are natural section containers. */
const BOUNDARY_TAGS = new Set([
  "section",
  "main",
  "article",
  "aside",
  "nav",
  "header",
  "footer",
  "form",
]);

/** Class-name suffixes that signal a structural container div. */
const CONTAINER_CLASS_RE =
  /(?:^|[_-])(card|panel|section|group|block|container|content|wrap)(?:$|[_-]|\s)/;

/** Minimum viewport area fraction for a container to count as "broad". */
const BROAD_AREA_THRESHOLD = 0.15;
/** Minimum viewport area fraction for a container to count as "tight". */
const TIGHT_AREA_THRESHOLD = 0.03;
const DEFAULT_BROAD_SELECTOR = ".content-area";

export type ResolvedContainers = {
  /** The nearest meaningful container around the click point. */
  tight: Element;
  /** A larger ancestor container (or the content area itself). */
  broad: Element;
};

function isMeaningfulContainer(el: Element): boolean {
  const tag = el.tagName.toLowerCase();

  if (BOUNDARY_TAGS.has(tag)) return true;

  const role = el.getAttribute("role");
  if (
    role === "region" ||
    role === "main" ||
    role === "navigation" ||
    role === "complementary" ||
    role === "contentinfo" ||
    role === "banner"
  ) {
    return true;
  }

  if (el.hasAttribute("data-stella-label") || el.hasAttribute("data-stella-view")) {
    return true;
  }

  // Structural divs with container-like class names and multiple children.
  if (
    tag === "div" &&
    el.children.length >= 2 &&
    typeof el.className === "string" &&
    CONTAINER_CLASS_RE.test(el.className)
  ) {
    return true;
  }

  return false;
}

function getViewportAreaFraction(el: Element): number {
  const rect = el.getBoundingClientRect();
  const viewportArea = window.innerWidth * window.innerHeight;
  if (viewportArea === 0) return 0;
  return (rect.width * rect.height) / viewportArea;
}

/**
 * Walk up from `target` to find tight and broad containers.
 * Falls back to document.body if nothing qualifies.
 */
export function resolveContextContainers(target: Element): ResolvedContainers {
  let tight: Element | null = null;
  let broad: Element | null = null;
  let el: Element | null = target;

  while (el && el !== document.documentElement) {
    if (el === document.body) {
      el = el.parentElement;
      continue;
    }

    const isBoundary = isMeaningfulContainer(el);
    const areaFraction = getViewportAreaFraction(el);

    // Tight: first semantic boundary OR element meeting the area threshold.
    // Boundaries count regardless of size so small sections near the
    // bottom of a page aren't skipped.
    if (!tight && (isBoundary || areaFraction >= TIGHT_AREA_THRESHOLD)) {
      tight = el;
    }

    // Broad: next ancestor above tight meeting the broad threshold.
    if (tight && el !== tight && areaFraction >= BROAD_AREA_THRESHOLD) {
      broad = el;
      break;
    }

    el = el.parentElement;
  }

  if (!tight) tight = target.closest("main, [role='main']") ?? document.body;

  // Better broad fallback: walk up from tight to find the next meaningful
  // ancestor rather than jumping straight to .content-area.
  if (!broad) {
    let parent = tight.parentElement;
    const tightArea = getViewportAreaFraction(tight);

    while (parent && parent !== document.body && parent !== document.documentElement) {
      const parentArea = getViewportAreaFraction(parent);
      // Accept an ancestor that is meaningfully larger than tight.
      if (parentArea >= BROAD_AREA_THRESHOLD || (isMeaningfulContainer(parent) && parentArea > tightArea * 1.5)) {
        broad = parent;
        break;
      }
      parent = parent.parentElement;
    }

    if (!broad) broad = document.querySelector(DEFAULT_BROAD_SELECTOR) ?? document.body;
  }

  if (broad === tight) {
    broad = tight.parentElement ?? document.body;
  }

  return { tight, broad };
}

export function deriveContextContainerLabel(tight: Element): string {
  const stellaLabel = tight.getAttribute("data-stella-label");
  if (stellaLabel) return stellaLabel;

  const ariaLabel = tight.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  const heading = tight.querySelector("h1, h2, h3, h4, h5, h6");
  if (heading) {
    const text = heading.textContent?.trim();
    if (text && text.length <= 40) return text;
    if (text) return `${text.slice(0, 37)}...`;
  }

  const tag = tight.tagName.toLowerCase();
  if (BOUNDARY_TAGS.has(tag)) {
    return tag.charAt(0).toUpperCase() + tag.slice(1);
  }

  const role = tight.getAttribute("role");
  if (role) return role.charAt(0).toUpperCase() + role.slice(1);

  const firstText = tight.querySelector("p, span, div");
  if (firstText) {
    const text = firstText.textContent?.trim();
    if (text && text.length <= 30) return text;
    if (text) return `${text.slice(0, 27)}...`;
  }

  return "this section";
}
