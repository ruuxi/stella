import type { ChatContext } from "@/shared/types/electron";

const SNAPSHOT_MAX_LINES = 80;
const SNAPSHOT_MAX_CHARS = 6_000;

const SKIP_TAGS = new Set(["script", "style", "noscript", "svg"]);
const STRUCTURAL_CLASS_RE =
  /(?:^|[\s_-])(card|panel|section|group|block|content|message|row|item|surface|view|main|sidebar)(?:$|[\s_-])/i;

const BOUNDARY_SELECTOR = [
  "[aria-label]",
  "[data-stella-label]",
  "[data-stella-action]",
  "main",
  "section",
  "article",
  "aside",
  "nav",
  "header",
  "footer",
  "form",
  "[role='main']",
  "[role='region']",
  "[role='navigation']",
  "[role='complementary']",
  "[role='article']",
  "[role='listitem']",
  "[role='button']",
  "button",
].join(",");

export type ComposerAreaSelection = NonNullable<ChatContext["appSelection"]>;

export type SelectionTarget = {
  element: Element;
  bounds: ComposerAreaSelection["bounds"];
  label: string;
  snapshot: string;
};

const isVisible = (element: Element): boolean => {
  const rect = element.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return false;
  const style = window.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
};

const textOf = (element: Element): string =>
  (element.textContent ?? "").replace(/\s+/g, " ").trim();

const isMeaningfulElement = (element: Element): boolean => {
  if (!isVisible(element)) return false;
  if (element.closest("[data-composer-area-select-ignore='true']")) return false;

  const tag = element.tagName.toLowerCase();
  if (["html", "body"].includes(tag)) return false;
  if (element.matches(BOUNDARY_SELECTOR)) return true;
  if (
    typeof element.className === "string" &&
    STRUCTURAL_CLASS_RE.test(element.className) &&
    textOf(element).length > 0
  ) {
    return true;
  }
  return false;
};

const scoreCandidate = (element: Element): number => {
  const rect = element.getBoundingClientRect();
  const area = rect.width * rect.height;
  let score = 0;

  if (element.hasAttribute("data-stella-label")) score += 80;
  if (element.hasAttribute("aria-label")) score += 65;
  if (element.querySelector("h1,h2,h3,h4,h5,h6")) score += 45;
  if (element.matches("button,[role='button'],[role='listitem']")) score += 35;
  if (element.matches("main,section,article,aside,nav,form,[role='region']")) score += 30;
  if (typeof element.className === "string" && STRUCTURAL_CLASS_RE.test(element.className)) {
    score += 20;
  }

  const textLength = textOf(element).length;
  if (textLength > 0) score += Math.min(24, textLength / 12);

  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  const areaRatio = area / viewportArea;
  if (areaRatio > 0.75) score -= 90;
  else if (areaRatio > 0.45) score -= 35;
  else if (areaRatio < 0.002) score -= 35;

  return score;
};

const resolveElementAtPoint = (x: number, y: number): Element | null => {
  const initial = document.elementFromPoint(x, y);
  if (!initial) return null;

  const candidates: Element[] = [];
  let current: Element | null = initial;
  while (current && current !== document.documentElement) {
    if (isMeaningfulElement(current)) {
      candidates.push(current);
    }
    current = current.parentElement;
  }

  if (candidates.length === 0) {
    const fallback = initial.closest<HTMLElement>("main, [role='main'], .content-area");
    return fallback && isVisible(fallback) ? fallback : null;
  }

  return candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a))[0] ?? null;
};

const getAccessibleLabel = (element: Element): string => {
  const explicit =
    element.getAttribute("data-stella-label") ||
    element.getAttribute("aria-label") ||
    element.getAttribute("title");
  if (explicit?.trim()) return explicit.trim();

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const label = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (label) return label;
  }

  const heading = element.querySelector("h1,h2,h3,h4,h5,h6");
  const headingText = heading?.textContent?.replace(/\s+/g, " ").trim();
  if (headingText) return truncate(headingText, 48);

  const ownText = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  if (ownText) return truncate(ownText, 48);

  const text = textOf(element);
  if (text) return truncate(text, 48);

  return "Selected area";
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const formatElementLine = (element: Element, depth: number): string | null => {
  const tag = element.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag) || !isVisible(element)) return null;

  const indent = "  ".repeat(Math.min(depth, 4));
  const label = getAccessibleLabel(element);

  if (element.matches("button,[role='button']")) return `${indent}[button] ${label}`;
  if (element.matches("a[href]")) return `${indent}[link] ${label}`;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const value = element.value || element.placeholder || label;
    return `${indent}[input] ${truncate(value, 120)}`;
  }
  if (element.hasAttribute("aria-label") || element.hasAttribute("data-stella-label")) {
    return `${indent}[${label}]`;
  }

  if (element.children.length === 0) {
    const text = textOf(element);
    return text ? `${indent}${truncate(text, 180)}` : null;
  }

  return null;
};

const buildSnapshot = (root: Element): string => {
  const lines: string[] = [];

  const walk = (element: Element, depth: number) => {
    if (lines.length >= SNAPSHOT_MAX_LINES) return;
    const line = formatElementLine(element, depth);
    if (line && lines[lines.length - 1] !== line) {
      lines.push(line);
    }
    for (const child of Array.from(element.children)) {
      walk(child, line ? depth + 1 : depth);
      if (lines.length >= SNAPSHOT_MAX_LINES) break;
    }
  };

  walk(root, 0);
  const snapshot = lines.join("\n").trim() || truncate(textOf(root), SNAPSHOT_MAX_CHARS);
  return truncate(snapshot, SNAPSHOT_MAX_CHARS);
};

export const resolveComposerAreaSelection = (
  x: number,
  y: number,
): SelectionTarget | null => {
  const element = resolveElementAtPoint(x, y);
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  const snapshot = buildSnapshot(element);
  if (!snapshot) return null;

  return {
    element,
    label: getAccessibleLabel(element),
    snapshot,
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
};
