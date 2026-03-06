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
// Visibility / Interactivity helpers
// ---------------------------------------------------------------------------

function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getAccessibleName(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent?.trim() ?? "";
  }

  // For inputs, check placeholder
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder) return el.placeholder;
  }

  // Direct text content (shallow — only immediate text nodes)
  const text = Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  if (text) return text;

  // Full text content (truncated)
  const full = el.textContent?.trim() ?? "";
  return full.length > 60 ? `${full.slice(0, 57)}...` : full;
}

// ---------------------------------------------------------------------------
// Snapshot walker
// ---------------------------------------------------------------------------

function buildSnapshot(): string {
  resetRefs();
  const lines: string[] = [];

  // Current view context
  const viewEl = document.querySelector("[data-stella-view]");
  if (viewEl) {
    lines.push(`[view: ${viewEl.getAttribute("data-stella-view")}]`);
  }

  walkElement(document.body, 0, lines);

  return lines.join("\n");
}

function walkElement(el: Element, depth: number, lines: string[]): void {
  if (!isVisible(el)) return;

  // Skip script, style, svg internals
  const tag = el.tagName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "noscript") return;

  const indent = "  ".repeat(depth);
  const label = el.getAttribute("data-stella-label");
  const state = el.getAttribute("data-stella-state");
  const action = el.getAttribute("data-stella-action");

  // Annotated section
  if (label) {
    let line = `${indent}[${label}]`;
    if (state) line += ` ${state}`;
    lines.push(line);

    // Walk children at increased depth
    for (const child of el.children) {
      walkElement(child, depth + 1, lines);
    }
    return;
  }

  // Interactive element
  const role = el.getAttribute("role");
  const isButton = tag === "button" || role === "button";
  const isInput = tag === "input" || tag === "textarea";
  const isSelect = tag === "select";
  const isLink = tag === "a" && el.hasAttribute("href");
  const isClickable = role === "menuitem" || role === "option" || role === "tab";
  const isInteractive = isButton || isInput || isSelect || isLink || isClickable;

  if (isInteractive) {
    const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
    if (disabled) return;

    const ref = nextRef();
    refToElement.set(ref, el);
    const name = action || getAccessibleName(el);

    if (isButton || isClickable) {
      lines.push(`${indent}[btn ${ref}] ${name}`);
    } else if (isInput) {
      const inputEl = el as HTMLInputElement;
      const val = inputEl.value;
      const type = inputEl.type || "text";
      if (type === "checkbox" || type === "radio") {
        lines.push(`${indent}[${type} ${ref}] ${name}: ${inputEl.checked ? "on" : "off"}`);
      } else {
        lines.push(`${indent}[input ${ref}] ${name}${val ? `: "${val}"` : ""}`);
      }
    } else if (isSelect) {
      const selectEl = el as HTMLSelectElement;
      const selected = selectEl.options[selectEl.selectedIndex]?.text ?? "";
      lines.push(`${indent}[select ${ref}] ${name}: "${selected}"`);
    } else if (isLink) {
      lines.push(`${indent}[link ${ref}] ${name}`);
    }
    return; // Don't recurse into interactive elements
  }

  // Non-interactive text content (leaf nodes with meaningful text)
  const hasChildren = el.children.length > 0;
  if (!hasChildren) {
    const text = el.textContent?.trim();
    if (text && text.length > 0 && text.length < 200) {
      // Skip purely decorative/empty elements
      const cls = el.className;
      if (typeof cls === "string" && (cls.includes("skeleton") || cls.includes("shimmer"))) {
        return;
      }
      lines.push(`${indent}${text}`);
    }
    return;
  }

  // Container — recurse
  for (const child of el.children) {
    walkElement(child, depth, lines);
  }
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
