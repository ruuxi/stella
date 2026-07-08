/**
 * Canvas tab — right sidebar viewer for HTML artifacts the orchestrator
 * produced via the `html` tool. Layout is a chip rail of saved canvases
 * over a sandboxed iframe rendering the selected file as `srcdoc`.
 */

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import {
  type CanvasHtmlItem,
  getCanvasHtmlItems,
  getSelectedCanvasHtmlId,
  loadCanvasHtmlHistory,
  setSelectedCanvasHtmlId,
  subscribeCanvasHtmlItems,
  subscribeSelectedCanvasHtmlId,
} from "./canvas-items";
import { CanvasIllustration } from "../illustrations/CanvasIllustration";
import "./canvas-tab.css";

const decoder = new TextDecoder("utf-8");

const CANVAS_SELECTION_BRIDGE_SCRIPT = String.raw`
(() => {
  const composeButton = document.createElement("button");
  composeButton.type = "button";
  composeButton.textContent = "Ask Stella";
  composeButton.setAttribute("aria-label", "Ask Stella about this");
  Object.assign(composeButton.style, {
    position: "fixed",
    zIndex: "2147483647",
    display: "none",
    alignItems: "center",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: "999px",
    background: "rgba(20,20,22,0.92)",
    color: "white",
    boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
    padding: "5px 9px",
    font: "600 12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    cursor: "default",
  });
  (document.body || document.documentElement).appendChild(composeButton);
  let activeComposeText = "";
  let hideTimer = 0;

  const findComposeTarget = (target) => {
    if (!target || typeof target.closest !== "function") return null;
    return target.closest("[data-stella-compose]");
  };

  const readComposeText = (target) => {
    const raw = target.getAttribute("data-stella-compose") || target.textContent || "";
    return raw.replace(/\s+/g, " ").trim();
  };

  const showComposeButton = (target) => {
    window.clearTimeout(hideTimer);
    const text = readComposeText(target);
    if (!text) return;
    activeComposeText = text;
    const rect = target.getBoundingClientRect();
    composeButton.style.left = Math.max(8, Math.min(window.innerWidth - 104, rect.right - 96)) + "px";
    composeButton.style.top = Math.max(8, rect.top + 8) + "px";
    composeButton.style.display = "inline-flex";
  };

  const hideComposeButtonSoon = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      composeButton.style.display = "none";
      activeComposeText = "";
    }, 180);
  };

  document.addEventListener("mouseover", (event) => {
    const target = findComposeTarget(event.target);
    if (target) showComposeButton(target);
  }, true);
  document.addEventListener("mouseout", (event) => {
    const target = findComposeTarget(event.target);
    if (target) hideComposeButtonSoon();
  }, true);
  composeButton.addEventListener("mouseover", () => window.clearTimeout(hideTimer));
  composeButton.addEventListener("mouseout", hideComposeButtonSoon);
  composeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (activeComposeText) {
      parent.postMessage({ type: "stella:canvas-compose", text: activeComposeText }, "*");
    }
    composeButton.style.display = "none";
  });

  const post = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      parent.postMessage({ type: "stella:canvas-selection", selected: false }, "*");
      return;
    }
    const text = selection.toString();
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      parent.postMessage({ type: "stella:canvas-selection", selected: false }, "*");
      return;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if ((rect.width === 0 && rect.height === 0) || !Number.isFinite(rect.left)) {
      parent.postMessage({ type: "stella:canvas-selection", selected: false }, "*");
      return;
    }
    parent.postMessage({
      type: "stella:canvas-selection",
      selected: true,
      text,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    }, "*");
  };
  window.addEventListener("mouseup", () => setTimeout(post, 0), true);
  document.addEventListener("selectionchange", () => setTimeout(post, 0));
  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "stella:canvas-selection-clear") {
      window.getSelection()?.removeAllRanges();
      post();
    }
  });
})();
`;

const injectCanvasSelectionBridge = (html: string): string => {
  const script = `<script>${CANVAS_SELECTION_BRIDGE_SCRIPT}</script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`);
  }
  return `${html}${script}`;
};

const CanvasLoadingDots = () => (
  <span className="canvas-tab__loading-dots" aria-hidden>
    <span>.</span>
    <span>.</span>
    <span>.</span>
  </span>
);

const CanvasIllustrationSpot = ({
  label,
}: {
  label?: ReactNode;
}) => (
  <div className="canvas-tab__illustration-spot">
    <div className="canvas-tab__illustration-art">
      <CanvasIllustration />
    </div>
    {label ? <div className="canvas-tab__illustration-label">{label}</div> : null}
  </div>
);

const CanvasHeroFrame = ({ item }: { item: CanvasHtmlItem }) => {
  const { bytes, error, loading } = useDisplayFileBytes(
    item.filePath,
    "Canvas preview requires the Stella desktop app.",
    undefined,
    // Same-slug canvases overwrite the same file in place; folding
    // `createdAt` into the read forces a fresh disk read (and iframe
    // remount below) so a re-opened/re-rendered canvas never shows stale
    // content served from the display-file cache.
    item.createdAt,
  );
  const html = useMemo(() => (bytes ? decoder.decode(bytes) : ""), [bytes]);
  const srcDoc = useMemo(
    () => (html ? injectCanvasSelectionBridge(html) : ""),
    [html],
  );

  if (error) {
    return (
      <div className="canvas-tab__frame-state canvas-tab__frame-state--error">
        Couldn't load this canvas.
      </div>
    );
  }
  if (loading || !html) {
    return (
      <CanvasIllustrationSpot
        label={
          <div className="canvas-tab__loading-label">
            Loading
            <CanvasLoadingDots />
          </div>
        }
      />
    );
  }

  return (
    <div className="canvas-tab__frame-wrap">
      <iframe
        key={`${item.id}:${item.createdAt}`}
        title={item.title}
        className="canvas-tab__iframe"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-popups allow-modals allow-forms"
        referrerPolicy="no-referrer"
      />
    </div>
  );
};

const useCanvasItems = (
  initial: ReadonlyArray<CanvasHtmlItem>,
): ReadonlyArray<CanvasHtmlItem> =>
  useSyncExternalStore(
    subscribeCanvasHtmlItems,
    getCanvasHtmlItems,
    () => initial,
  );

const useSelectedCanvasId = (
  fallback: string | null,
): string | null =>
  useSyncExternalStore(
    subscribeSelectedCanvasHtmlId,
    getSelectedCanvasHtmlId,
    () => fallback,
  );

export const CanvasTabContent = ({
  items: initialItems,
  selectedItemId,
}: {
  items: ReadonlyArray<CanvasHtmlItem>;
  selectedItemId?: string;
}) => {
  const items = useCanvasItems(initialItems);
  const selectedId = useSelectedCanvasId(
    selectedItemId ?? items.at(-1)?.id ?? null,
  );

  useEffect(() => {
    void loadCanvasHtmlHistory();
  }, []);

  useEffect(() => {
    if (selectedItemId && items.some((item) => item.id === selectedItemId)) {
      setSelectedCanvasHtmlId(selectedItemId);
    }
  }, [items, selectedItemId]);

  useEffect(() => {
    if (items.length === 0) {
      setSelectedCanvasHtmlId(null);
      return;
    }
    if (!selectedId || !items.some((item) => item.id === selectedId)) {
      setSelectedCanvasHtmlId(items.at(-1)?.id ?? null);
    }
  }, [items, selectedId]);

  const selectedItem =
    items.find((item) => item.id === selectedId) ?? items.at(-1) ?? null;

  return (
    <div className="canvas-tab">
      <div className="canvas-tab__hero">
        {selectedItem ? (
          <CanvasHeroFrame item={selectedItem} />
        ) : (
          <div className="canvas-tab__hero-empty">
            <CanvasIllustrationSpot />
            <div className="canvas-tab__hero-empty-title">Canvases land here</div>
            <div className="canvas-tab__hero-empty-hint">
              Charts, plans, comparisons, and other HTML views Stella renders
              are saved here.
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
