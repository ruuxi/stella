import { useEffect, useRef, useState, useCallback } from "react";
import { marked } from "marked";
import markedShiki from "marked-shiki";
import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import DOMPurify from "dompurify";
import { cn } from "@/lib/utils";
import "./markdown.css";

// LRU Cache for parsed markdown
type CacheEntry = {
  hash: string;
  html: string;
};

const MAX_CACHE_SIZE = 200;
const cache = new Map<string, CacheEntry>();

function touchCache(key: string, value: CacheEntry) {
  cache.delete(key);
  cache.set(key, value);

  if (cache.size <= MAX_CACHE_SIZE) return;

  const first = cache.keys().next().value;
  if (first) cache.delete(first);
}

// Simple hash function
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

// Shared highlighter instance
let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: [],
    });
  }
  return highlighterPromise;
}

// Configure marked with shiki
async function configureMarked() {
  const highlighter = await getHighlighter();

  return marked.use(
    {
      renderer: {
        link({ href, title, text }) {
          const titleAttr = title ? ` title="${title}"` : "";
          return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`;
        },
      },
    },
    markedShiki({
      async highlight(code, lang) {
        let language = lang || "text";
        if (!(language in bundledLanguages)) {
          language = "text";
        }
        if (!highlighter.getLoadedLanguages().includes(language)) {
          await highlighter.loadLanguage(language as BundledLanguage);
        }
        return highlighter.codeToHtml(code, {
          lang: language,
          theme: "github-dark",
        });
      },
    })
  );
}

// DOMPurify config
const PURIFY_CONFIG = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
};

// Setup DOMPurify hooks
if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return;
    if (node.target !== "_blank") return;

    const rel = node.getAttribute("rel") ?? "";
    const set = new Set(rel.split(/\s+/).filter(Boolean));
    set.add("noopener");
    set.add("noreferrer");
    node.setAttribute("rel", Array.from(set).join(" "));
  });
}

function sanitize(html: string): string {
  if (!DOMPurify.isSupported) return "";
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

// Icon SVG paths
const ICON_PATHS = {
  copy: '<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>',
  check: '<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>',
};

function createCopyButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "markdown-copy-button";
  button.setAttribute("aria-label", "Copy code");
  button.setAttribute("title", "Copy code");

  // Copy icon
  const copyIcon = document.createElement("span");
  copyIcon.className = "copy-icon";
  copyIcon.innerHTML = `<svg fill="none" viewBox="0 0 20 20" aria-hidden="true">${ICON_PATHS.copy}</svg>`;

  // Check icon
  const checkIcon = document.createElement("span");
  checkIcon.className = "check-icon";
  checkIcon.innerHTML = `<svg fill="none" viewBox="0 0 20 20" aria-hidden="true">${ICON_PATHS.check}</svg>`;

  button.appendChild(copyIcon);
  button.appendChild(checkIcon);

  return button;
}

function setupCodeCopy(root: HTMLDivElement): () => void {
  const timeouts = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();

  const ensureWrapper = (block: HTMLPreElement) => {
    const parent = block.parentElement;
    if (!parent) return;
    if (parent.classList.contains("markdown-code")) return;

    const wrapper = document.createElement("div");
    wrapper.className = "markdown-code";
    parent.replaceChild(wrapper, block);
    wrapper.appendChild(block);
    wrapper.appendChild(createCopyButton());
  };

  const handleClick = async (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest(".markdown-copy-button");
    if (!(button instanceof HTMLButtonElement)) return;

    const code = button.closest(".markdown-code")?.querySelector("code");
    const content = code?.textContent ?? "";
    if (!content) return;

    const clipboard = navigator?.clipboard;
    if (!clipboard) return;

    await clipboard.writeText(content);
    button.setAttribute("data-copied", "true");

    const existing = timeouts.get(button);
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(() => {
      button.removeAttribute("data-copied");
    }, 2000);
    timeouts.set(button, timeout);
  };

  const blocks = Array.from(root.querySelectorAll("pre"));
  for (const block of blocks) {
    ensureWrapper(block);
  }

  root.addEventListener("click", handleClick);

  return () => {
    root.removeEventListener("click", handleClick);
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout);
    }
  };
}

interface MarkdownProps {
  text: string;
  cacheKey?: string;
  className?: string;
}

export function Markdown({ text, cacheKey, className }: MarkdownProps) {
  const [html, setHtml] = useState<string>("");
  const rootRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const parseMarkdown = useCallback(async (markdown: string) => {
    const hash = simpleHash(markdown);
    const key = cacheKey ?? hash;

    // Check cache
    if (key && hash) {
      const cached = cache.get(key);
      if (cached && cached.hash === hash) {
        touchCache(key, cached);
        return cached.html;
      }
    }

    // Parse markdown
    const parser = await configureMarked();
    const parsed = await parser.parse(markdown);
    const safe = sanitize(parsed);

    // Cache result
    if (key && hash) {
      touchCache(key, { hash, html: safe });
    }

    return safe;
  }, [cacheKey]);

  useEffect(() => {
    let cancelled = false;

    parseMarkdown(text).then((result) => {
      if (!cancelled) {
        setHtml(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [text, parseMarkdown]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !html) return;

    // Cleanup previous
    if (cleanupRef.current) {
      cleanupRef.current();
    }

    // Setup code copy buttons
    cleanupRef.current = setupCodeCopy(root);

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, [html]);

  return (
    <div
      ref={rootRef}
      className={cn("markdown", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
