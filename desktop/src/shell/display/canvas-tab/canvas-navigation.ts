export type CanvasNavigation =
  | { kind: "anchor"; fragment: string }
  | { kind: "external"; url: string }
  | { kind: "blocked" };

/** Classify navigation from a single-file canvas without resolving relative URLs. */
export const classifyCanvasNavigation = (href: string): CanvasNavigation => {
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) {
    return { kind: "anchor", fragment: trimmed.slice(1) };
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { kind: "external", url: url.href };
    }
  } catch {
    // Relative URLs have nowhere meaningful to go in a srcdoc canvas.
  }
  return { kind: "blocked" };
};
