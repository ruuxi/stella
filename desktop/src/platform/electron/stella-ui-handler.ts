import { buildDomSnapshot } from "@/shared/lib/stella-dom-snapshot";

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
const refToElement = new Map<string, Element>();

function resetRefs() {
  refCounter = 0;
  refToElement.clear();
}

function nextRef(): string {
  const ref = `@e${++refCounter}`;
  return ref;
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
      refToElement.set(ref, el);
      return ref;
    },
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function findElement(ref: string): Element | null {
  return refToElement.get(ref) ?? null;
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
    const nativeInputValueSetter =
      Object.getOwnPropertyDescriptor(
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
