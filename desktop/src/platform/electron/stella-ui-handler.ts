import {
  buildDomSnapshot,
  getAccessibleName,
  isVisibleForSnapshot,
} from "@/shared/lib/stella-dom-snapshot";

/**
 * stella-ui renderer handler.
 *
 * Walks the live DOM to produce a compact, LLM-friendly snapshot and
 * executes actions (click, fill, select) by element ref.
 *
 * Components can annotate their DOM with:
 *   data-stella-label   — section/component name
 *   data-stella-state   — current state summary
 *   data-stella-action  — action label for interactive elements
 */

// ---------------------------------------------------------------------------
// Ref tracking
// ---------------------------------------------------------------------------

let refCounter = 0;
const refToEntry = new Map<string, RefEntry>();
const roleNameCounts = new Map<string, number>();

type RefEntry = {
  element: Element | null;
  role: string;
  name: string;
  nth: number | null;
  valueText: string;
  ancestorPath: string[];
};

type RefCandidate = RefEntry & {
  element: Element;
};

const HIGH_SIGNAL_CONTAINER_TAGS = new Set([
  "article",
  "aside",
  "dialog",
  "form",
  "main",
  "nav",
  "section",
]);

const HIGH_SIGNAL_CONTAINER_ROLES = new Set([
  "dialog",
  "form",
  "group",
  "listbox",
  "main",
  "menu",
  "navigation",
  "radiogroup",
  "tablist",
  "tabpanel",
]);

function resetRefs() {
  refCounter = 0;
  refToEntry.clear();
  roleNameCounts.clear();
}

function nextRef(): string {
  const ref = `@e${++refCounter}`;
  return ref;
}

function normalizeLocatorText(value: string): string {
  return value
    .split(/\s+/)
    .map((segment) => segment.toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function getElementRole(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role")?.trim().toLowerCase() ?? "";

  if (
    el instanceof HTMLInputElement &&
    (el.type === "checkbox" || el.type === "radio")
  ) {
    return el.type;
  }
  if (tag === "button" || role === "button") return "button";
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "select") return "select";
  if (tag === "input" || tag === "textarea") return "input";
  if (role === "menuitem" || role === "option" || role === "tab") return role;
  return role || tag;
}

function getElementName(el: Element): string {
  const action = el.getAttribute("data-stella-action")?.trim();
  return action || getAccessibleName(el).trim();
}

function getElementValueText(el: Element): string {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") {
      return el.checked ? "on" : "off";
    }
    return el.value.trim();
  }
  if (el instanceof HTMLTextAreaElement) {
    return el.value.trim();
  }
  if (el instanceof HTMLSelectElement) {
    return el.options[el.selectedIndex]?.text?.trim() ?? "";
  }
  return "";
}

function buildAncestorPath(el: Element, maxLen = 3): string[] {
  const path: string[] = [];
  let current = el.parentElement;

  while (current && path.length < maxLen) {
    const stellaLabel = current.getAttribute("data-stella-label")?.trim();
    const viewLabel = current.getAttribute("data-stella-view")?.trim();
    const role =
      current.getAttribute("role")?.trim().toLowerCase() ??
      current.tagName.toLowerCase();
    const ariaLabel = current.getAttribute("aria-label")?.trim();
    const id = current instanceof HTMLElement ? current.id.trim() : "";

    if (stellaLabel) {
      path.push(`label:${stellaLabel}`);
    } else if (viewLabel) {
      path.push(`view:${viewLabel}`);
    } else if (ariaLabel) {
      path.push(`${role}:${ariaLabel}`);
    } else if (id) {
      path.push(`${role}:${id}`);
    } else if (
      HIGH_SIGNAL_CONTAINER_TAGS.has(role) ||
      HIGH_SIGNAL_CONTAINER_ROLES.has(role)
    ) {
      path.push(`${role}:`);
    }

    current = current.parentElement;
  }

  path.reverse();
  return path;
}

function buildRefEntry(el: Element): RefEntry {
  return {
    element: el,
    role: getElementRole(el),
    name: getElementName(el),
    nth: null,
    valueText: getElementValueText(el),
    ancestorPath: buildAncestorPath(el),
  };
}

function isInteractiveElement(el: Element): boolean {
  if (!isVisibleForSnapshot(el, false)) {
    return false;
  }
  if (
    el.hasAttribute("disabled") ||
    el.getAttribute("aria-disabled") === "true"
  ) {
    return false;
  }

  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role")?.trim().toLowerCase() ?? "";

  return (
    tag === "button" ||
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    (tag === "a" && el.hasAttribute("href")) ||
    role === "button" ||
    role === "menuitem" ||
    role === "option" ||
    role === "tab"
  );
}

function collectInteractiveCandidates(): RefCandidate[] {
  const candidates: RefCandidate[] = [];
  const counts = new Map<string, number>();

  for (const el of document.body.querySelectorAll("*")) {
    if (!isInteractiveElement(el)) {
      continue;
    }

    const entry = buildRefEntry(el);
    const key = `${entry.role}:${entry.name}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);

    candidates.push({
      ...entry,
      element: el,
      nth,
    });
  }

  return candidates;
}

function longestCommonAncestorSuffix(
  expected: string[],
  actual: string[],
): number {
  let matches = 0;

  for (
    let offset = 1;
    offset <= Math.min(expected.length, actual.length);
    offset += 1
  ) {
    if (
      normalizeLocatorText(expected[expected.length - offset] ?? "") !==
      normalizeLocatorText(actual[actual.length - offset] ?? "")
    ) {
      break;
    }
    matches += 1;
  }

  return matches;
}

function scoreTextMatch(expected: string, actual: string): number {
  const normalizedExpected = normalizeLocatorText(expected);
  const normalizedActual = normalizeLocatorText(actual);

  if (!normalizedExpected || !normalizedActual) {
    return 0;
  }
  if (normalizedExpected === normalizedActual) {
    return 120;
  }
  if (
    normalizedActual.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedActual)
  ) {
    return 80;
  }

  const actualTokens = normalizedActual.split(" ");
  const overlap = normalizedExpected
    .split(" ")
    .filter((token) => token && actualTokens.includes(token)).length;

  return overlap * 25;
}

function scoreCandidate(entry: RefEntry, candidate: RefCandidate): number {
  if (entry.role !== candidate.role) {
    return Number.NEGATIVE_INFINITY;
  }

  return (
    200 +
    scoreTextMatch(entry.name, candidate.name) +
    Math.floor(scoreTextMatch(entry.valueText, candidate.valueText) / 2) +
    longestCommonAncestorSuffix(entry.ancestorPath, candidate.ancestorPath) * 35
  );
}

function selectBestCandidate(
  entry: RefEntry,
  candidates: RefCandidate[],
): RefCandidate | null {
  let best: RefCandidate | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let secondBest = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const score = scoreCandidate(entry, candidate);
    if (score > bestScore) {
      secondBest = bestScore;
      bestScore = score;
      best = candidate;
    } else if (score > secondBest) {
      secondBest = score;
    }
  }

  const minimumScore = normalizeLocatorText(entry.name) ? 260 : 235;
  if (!best || bestScore < minimumScore || bestScore === secondBest) {
    return null;
  }

  return best;
}

function refetchElement(entry: RefEntry): Element | null {
  const candidates = collectInteractiveCandidates().filter(
    (candidate) => candidate.role === entry.role,
  );
  if (candidates.length === 0) {
    return null;
  }

  const expectedName = normalizeLocatorText(entry.name);
  const exactMatches = candidates.filter((candidate) => {
    const candidateName = normalizeLocatorText(candidate.name);
    return (
      (expectedName.length === 0 && candidateName.length === 0) ||
      (expectedName.length > 0 && candidateName === expectedName)
    );
  });
  const exactMatch = exactMatches[entry.nth ?? 0];
  if (exactMatch) {
    return exactMatch.element;
  }

  return selectBestCandidate(entry, candidates)?.element ?? null;
}

// ---------------------------------------------------------------------------
// Snapshot walker
// ---------------------------------------------------------------------------

function buildSnapshot(): string {
  resetRefs();

  const initialLines: string[] = [];
  const viewEl = document.querySelector("[data-stella-view]");
  if (viewEl) {
    initialLines.push(`[view: ${viewEl.getAttribute("data-stella-view")}]`);
  }

  return buildDomSnapshot({
    root: document.body,
    initialLines,
    registerRef: (el) => {
      const ref = nextRef();
      const entry = buildRefEntry(el);
      const key = `${entry.role}:${entry.name}`;
      const nth = roleNameCounts.get(key) ?? 0;
      roleNameCounts.set(key, nth + 1);
      refToEntry.set(ref, {
        ...entry,
        nth,
      });
      return ref;
    },
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function findElement(ref: string): Element | null {
  const entry = refToEntry.get(ref);
  if (!entry) {
    return null;
  }
  if (
    entry.element &&
    entry.element.isConnected &&
    isInteractiveElement(entry.element)
  ) {
    return entry.element;
  }

  const freshElement = refetchElement(entry);
  if (!freshElement) {
    return null;
  }

  refToEntry.set(ref, {
    ...entry,
    element: freshElement,
    valueText: getElementValueText(freshElement),
    ancestorPath: buildAncestorPath(freshElement),
  });
  return freshElement;
}

function executeClick(ref: string): string {
  const el = findElement(ref);
  if (!el) return `Error: element ${ref} not found. Run snapshot first.`;
  if (el instanceof HTMLElement) {
    el.click();
    return `Clicked ${ref}`;
  }
  return `Error: element ${ref} is not clickable`;
}

function executeFill(ref: string, value: string): string {
  const el = findElement(ref);
  if (!el) return `Error: element ${ref} not found. Run snapshot first.`;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Use native setter to trigger React's synthetic events
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return `Filled ${ref} with "${value}"`;
  }
  return `Error: element ${ref} is not an input`;
}

function executeSelect(ref: string, value: string): string {
  const el = findElement(ref);
  if (!el) return `Error: element ${ref} not found. Run snapshot first.`;
  if (el instanceof HTMLSelectElement) {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return `Selected "${value}" on ${ref}`;
  }
  return `Error: element ${ref} is not a select`;
}

// ---------------------------------------------------------------------------
// Command dispatcher (called from main process via executeJavaScript)
// ---------------------------------------------------------------------------

function handleCommand(command: string, args: string[]): string {
  switch (command) {
    case "snapshot":
      return buildSnapshot();
    case "click":
      return executeClick(args[0] ?? "");
    case "fill":
      return executeFill(args[0] ?? "", args.slice(1).join(" "));
    case "select":
      return executeSelect(args[0] ?? "", args.slice(1).join(" "));
    default:
      return `Unknown command: ${command}. Available: snapshot, click, fill, select`;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function initStellaUiHandler() {
  (window as unknown as Record<string, unknown>).__stellaUI = {
    handleCommand,
    snapshot: buildSnapshot,
  };
}
