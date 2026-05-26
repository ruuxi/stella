/**
 * Canvas tab — workspace-panel viewer for HTML artifacts the orchestrator
 * produced via the `html` tool. Layout is a chip rail of saved canvases
 * over a sandboxed iframe rendering the selected file as `srcdoc`.
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { X } from "lucide-react";
import { displayTabs } from "../tab-store";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import {
  type CanvasHtmlItem,
  getCanvasHtmlItems,
  loadCanvasHtmlHistory,
  removeCanvasHtmlItem,
  subscribeCanvasHtmlItems,
} from "./canvas-items";
import { CanvasIllustration } from "../illustrations/CanvasIllustration";
import "./canvas-tab.css";

const decoder = new TextDecoder("utf-8");
const CANVAS_SELECTION_TUTORIAL_KEY = "stella.canvasSelectionTutorialSeen";

const readCanvasSelectionTutorialSeen = (): boolean => {
  try {
    return window.localStorage.getItem(CANVAS_SELECTION_TUTORIAL_KEY) === "1";
  } catch {
    return false;
  }
};

const markCanvasSelectionTutorialSeen = (): void => {
  try {
    window.localStorage.setItem(CANVAS_SELECTION_TUTORIAL_KEY, "1");
  } catch {
    // Ignore storage failures; the hint is nonessential.
  }
};

const CANVAS_SELECTION_BRIDGE_SCRIPT = String.raw`
(() => {
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
  const script = `<script>${CANVAS_SELECTION_BRIDGE_SCRIPT}<\/script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${script}</body>`);
  }
  return `${html}${script}`;
};

const expandPanel = () => displayTabs.setPanelExpanded(true);

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
  );
  const html = useMemo(() => (bytes ? decoder.decode(bytes) : ""), [bytes]);
  const srcDoc = useMemo(
    () => (html ? injectCanvasSelectionBridge(html) : ""),
    [html],
  );
  const [showSelectionTutorial, setShowSelectionTutorial] = useState(
    () => !readCanvasSelectionTutorialSeen(),
  );

  const dismissSelectionTutorial = () => {
    markCanvasSelectionTutorialSeen();
    setShowSelectionTutorial(false);
  };

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
      {showSelectionTutorial ? (
        <div className="canvas-tab__selection-tutorial" role="dialog">
          <div className="canvas-tab__selection-tutorial-label">
            Ask Stella from reports
          </div>
          <p>
            Select any text in this report, then choose Ask Stella to place it
            into chat.
          </p>
          <button type="button" onClick={dismissSelectionTutorial}>
            Got it
          </button>
        </div>
      ) : null}
    </div>
  );
};

const CanvasTileGlyph = () => (
  <svg
    className="canvas-tab__tile-glyph"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden
  >
    <rect
      x="4"
      y="5"
      width="16"
      height="14"
      rx="2.4"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path
      d="M8 14l3-3 2.4 2.4L17 10"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const useCanvasItems = (
  initial: ReadonlyArray<CanvasHtmlItem>,
): ReadonlyArray<CanvasHtmlItem> =>
  useSyncExternalStore(
    subscribeCanvasHtmlItems,
    getCanvasHtmlItems,
    () => initial,
  );

const CanvasHistoryTile = ({
  item,
  isActive,
  onSelect,
}: {
  item: CanvasHtmlItem;
  isActive: boolean;
  onSelect: () => void;
}) => {
  const handleCloseClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    removeCanvasHtmlItem(item.filePath);
  };

  return (
    <div
      className={`canvas-tab__tile${isActive ? " canvas-tab__tile--active" : ""}`}
    >
      <button
        type="button"
        className="canvas-tab__tile-main"
        onClick={onSelect}
        onDoubleClick={expandPanel}
        title={item.title}
        aria-label={item.title}
        aria-pressed={isActive}
      >
        <CanvasTileGlyph />
        <span className="canvas-tab__tile-label">{item.title}</span>
      </button>
      <button
        type="button"
        className="canvas-tab__tile-remove"
        onClick={handleCloseClick}
        aria-label={`Close ${item.title}`}
        title="Close"
      >
        <X size={12} strokeWidth={2.2} />
      </button>
    </div>
  );
};

export const CanvasTabContent = ({
  items: initialItems,
}: {
  items: ReadonlyArray<CanvasHtmlItem>;
}) => {
  const items = useCanvasItems(initialItems);
  const [selectedId, setSelectedId] = useState<string | null>(
    items.at(-1)?.id ?? null,
  );

  useEffect(() => {
    void loadCanvasHtmlHistory();
  }, []);

  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !items.some((item) => item.id === selectedId)) {
      setSelectedId(items.at(-1)?.id ?? null);
    }
  }, [items, selectedId]);

  const selectedItem =
    items.find((item) => item.id === selectedId) ?? items.at(-1) ?? null;

  return (
    <div className="canvas-tab">
      {items.length > 0 && (
        <div className="canvas-tab__rail" aria-label="Saved canvases">
          {items.map((item) => (
            <CanvasHistoryTile
              key={item.id}
              item={item}
              isActive={item.id === selectedItem?.id}
              onSelect={() => setSelectedId(item.id)}
            />
          ))}
        </div>
      )}

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
