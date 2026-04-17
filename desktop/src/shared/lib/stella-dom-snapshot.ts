type BuildDomSnapshotOptions = {
  root: Element;
  maxLines?: number;
  requireViewportIntersection?: boolean;
  skipTags?: ReadonlySet<string>;
  capIndentDepth?: number;
  initialLines?: string[];
  registerRef?: (el: Element) => string;
  skipUnnamedInteractive?: boolean;
};

const DEFAULT_SKIP_TAGS = new Set(["script", "style", "noscript"]);

export function isVisibleForSnapshot(
  el: Element,
  requireViewportIntersection: boolean,
): boolean {
  // Check rect first — cheaper than getComputedStyle and catches display:none
  // (which yields a zero rect) without forcing style resolution.
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  if (!requireViewportIntersection) {
    return true;
  }

  return (
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

export function getAccessibleName(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.textContent?.trim() ?? "";
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder) return el.placeholder;
  }

  const text = Array.from(el.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  if (text) return text;

  const full = el.textContent?.trim() ?? "";
  return full.length > 60 ? `${full.slice(0, 57)}...` : full;
}

function formatInteractiveLine(
  prefix: string,
  name: string,
  suffix = "",
): string {
  return `${prefix}${name ? ` ${name}` : ""}${suffix}`;
}

function walkSnapshotElement(
  el: Element,
  depth: number,
  lines: string[],
  options: Required<
    Pick<
      BuildDomSnapshotOptions,
      | "maxLines"
      | "requireViewportIntersection"
      | "capIndentDepth"
      | "skipUnnamedInteractive"
    >
  > &
    Pick<BuildDomSnapshotOptions, "skipTags" | "registerRef">,
): void {
  if (lines.length >= options.maxLines) return;

  const tag = el.tagName.toLowerCase();
  if (options.skipTags?.has(tag)) return;
  if (!isVisibleForSnapshot(el, options.requireViewportIntersection)) return;

  const indent = "  ".repeat(Math.min(depth, options.capIndentDepth));
  const label = el.getAttribute("data-stella-label");
  const state = el.getAttribute("data-stella-state");

  if (label) {
    let line = `${indent}[${label}]`;
    if (state) line += ` ${state}`;
    lines.push(line);

    for (const child of el.children) {
      walkSnapshotElement(child, depth + 1, lines, options);
    }
    return;
  }

  const role = el.getAttribute("role");
  const isButton = tag === "button" || role === "button";
  const isInput = tag === "input" || tag === "textarea";
  const isSelect = tag === "select";
  const isLink = tag === "a" && el.hasAttribute("href");
  const isClickable =
    role === "menuitem" || role === "option" || role === "tab";
  const isInteractive =
    isButton || isInput || isSelect || isLink || isClickable;

  if (isInteractive) {
    const disabled =
      el.hasAttribute("disabled") ||
      el.getAttribute("aria-disabled") === "true";
    if (disabled) return;

    const action = el.getAttribute("data-stella-action");
    const name = action || getAccessibleName(el);
    if (options.skipUnnamedInteractive && !name) return;

    const ref = options.registerRef?.(el);
    const refSuffix = ref ? ` ${ref}` : "";

    if (isInput) {
      const inputEl = el as HTMLInputElement;
      const type = inputEl.type || "text";
      if (type === "checkbox" || type === "radio") {
        lines.push(
          formatInteractiveLine(
            `${indent}[${type}${refSuffix}]`,
            name,
            `: ${inputEl.checked ? "on" : "off"}`,
          ),
        );
      } else {
        const val = inputEl.value;
        lines.push(
          formatInteractiveLine(
            `${indent}[input${refSuffix}]`,
            name,
            val ? `: "${val}"` : "",
          ),
        );
      }
    } else if (isSelect) {
      const selectEl = el as HTMLSelectElement;
      const selected = selectEl.options[selectEl.selectedIndex]?.text ?? "";
      lines.push(
        formatInteractiveLine(
          `${indent}[select${refSuffix}]`,
          name,
          `: "${selected}"`,
        ),
      );
    } else {
      lines.push(
        formatInteractiveLine(
          `${indent}[${isLink ? "link" : "btn"}${refSuffix}]`,
          name,
        ),
      );
    }
    return;
  }

  if (el.children.length === 0) {
    const text = el.textContent?.trim();
    if (text && text.length > 0 && text.length < 200) {
      const cls = el.className;
      if (
        typeof cls === "string" &&
        (cls.includes("skeleton") || cls.includes("shimmer"))
      ) {
        return;
      }
      lines.push(`${indent}${text}`);
    }
    return;
  }

  for (const child of el.children) {
    walkSnapshotElement(child, depth, lines, options);
  }
}

export function buildDomSnapshot({
  root,
  maxLines = Number.POSITIVE_INFINITY,
  requireViewportIntersection = false,
  skipTags = DEFAULT_SKIP_TAGS,
  capIndentDepth = Number.POSITIVE_INFINITY,
  initialLines = [],
  registerRef,
  skipUnnamedInteractive = false,
}: BuildDomSnapshotOptions): string {
  const lines = [...initialLines];

  walkSnapshotElement(root, 0, lines, {
    maxLines,
    requireViewportIntersection,
    skipTags,
    capIndentDepth,
    registerRef,
    skipUnnamedInteractive,
  });

  return lines.join("\n");
}
