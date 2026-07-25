/**
 * Canvas viewer for one HTML artifact the orchestrator produced via the
 * `html` tool: a share bar over a sandboxed iframe rendering the file as
 * `srcdoc`. Which canvas is showing is the Files section's business, so this
 * takes the item it should render rather than picking one.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import { openExternalUrl } from "@/platform/electron/open-external";
import { type CanvasHtmlItem } from "./canvas-items";
import { CanvasIllustration } from "../illustrations/CanvasIllustration";
import { CanvasShareBar } from "./CanvasShareBar";
import { classifyCanvasNavigation } from "./canvas-navigation";
import "./canvas-tab.css";

const decoder = new TextDecoder("utf-8");

const CANVAS_SELECTION_BRIDGE_SCRIPT = String.raw`
(() => {
  const navigate = (rawHref) => {
    const href = rawHref.trim();
    if (href.startsWith("#")) {
      const fragment = decodeURIComponent(href.slice(1));
      if (!fragment) {
        window.scrollTo({ top: 0, behavior: "auto" });
        return;
      }
      const target = document.getElementById(fragment) ||
        document.querySelector('[name="' + CSS.escape(fragment) + '"]');
      target?.scrollIntoView();
      return;
    }
    try {
      const url = new URL(href);
      if (url.protocol === "http:" || url.protocol === "https:") {
        parent.postMessage({ type: "stella:canvas-open-external", url: url.href }, "*");
      }
    } catch {
      // A relative destination cannot exist outside this single srcdoc file.
    }
  };

  document.addEventListener("click", (event) => {
    const target = event.target;
    const anchor = target && typeof target.closest === "function"
      ? target.closest("a[href]")
      : null;
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    navigate(anchor.getAttribute("href") || "");
  }, true);

  document.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const form = event.target;
    if (form && typeof form.getAttribute === "function") {
      navigate(form.getAttribute("action") || "");
    }
  }, true);

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

const CanvasIllustrationSpot = ({ label }: { label?: ReactNode }) => (
  <div className="canvas-tab__illustration-spot">
    <div className="canvas-tab__illustration-art">
      <CanvasIllustration />
    </div>
    {label ? (
      <div className="canvas-tab__illustration-label">{label}</div>
    ) : null}
  </div>
);

const CanvasHeroFrameContent = ({ item }: { item: CanvasHtmlItem }) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const loadCountRef = useRef(0);
  const [navigationReset, setNavigationReset] = useState(0);
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

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (
        data?.type === "stella:canvas-open-external" &&
        typeof data.url === "string"
      ) {
        const navigation = classifyCanvasNavigation(data.url);
        if (navigation.kind === "external") {
          openExternalUrl(navigation.url);
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

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
        key={`${item.id}:${item.createdAt}:${navigationReset}`}
        ref={iframeRef}
        title={item.title}
        className="canvas-tab__iframe"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-popups allow-modals allow-forms"
        referrerPolicy="no-referrer"
        onLoad={() => {
          // The first load is srcdoc. Any later load means script-driven or
          // otherwise uncaught navigation escaped the click/form bridge;
          // remount the original document instead of leaving a broken frame.
          loadCountRef.current += 1;
          if (loadCountRef.current > 1) {
            loadCountRef.current = 0;
            setNavigationReset((value) => value + 1);
          }
        }}
      />
    </div>
  );
};

const CanvasHeroFrame = ({
  item,
  panelOpen,
}: {
  item: CanvasHtmlItem;
  panelOpen: boolean;
}) => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!panelOpen || ready) return;

    // A canvas can already be mounted in the hidden keep-alive host when a
    // sidebar artifact is clicked. Starting its file read (or replacing its
    // srcdoc iframe) during that click blocks Chromium's renderer before the
    // panel gets a chance to paint. Wait for a frame of the open shell first;
    // the keyed boundary below also makes a same-path overwrite start from
    // this lightweight loading state instead of remounting with stale bytes.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [panelOpen, ready]);

  if (!ready) {
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

  return <CanvasHeroFrameContent item={item} />;
};

export const CanvasTabContent = ({ item }: { item: CanvasHtmlItem }) => {
  const panelOpen = useDisplayPanelOpen();

  return (
    <div className="canvas-tab">
      <div className="canvas-tab__hero">
        <CanvasShareBar item={item} />
        <CanvasHeroFrame
          key={`${item.id}:${item.createdAt}`}
          item={item}
          panelOpen={panelOpen}
        />
      </div>
    </div>
  );
};
