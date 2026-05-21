/**
 * Canvas tab — workspace-panel viewer for HTML artifacts the orchestrator
 * produced via the `html` tool. Layout is a chip rail of saved canvases
 * over a sandboxed iframe rendering the selected file as `srcdoc`.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import "./canvas-tab.css";

const decoder = new TextDecoder("utf-8");

const expandPanel = () => displayTabs.setPanelExpanded(true);

const CanvasHeroFrame = ({ item }: { item: CanvasHtmlItem }) => {
  const { bytes, error, loading } = useDisplayFileBytes(
    item.filePath,
    "Canvas preview requires the Stella desktop app.",
  );
  const html = useMemo(() => (bytes ? decoder.decode(bytes) : ""), [bytes]);

  if (error) {
    return (
      <div className="canvas-tab__frame-state canvas-tab__frame-state--error">
        Couldn't load this canvas.
      </div>
    );
  }
  if (loading || !html) {
    return <div className="canvas-tab__skeleton" aria-hidden />;
  }

  return (
    <iframe
      key={`${item.id}:${item.createdAt}`}
      title={item.title}
      className="canvas-tab__iframe"
      srcDoc={html}
      sandbox="allow-scripts allow-popups allow-modals allow-forms"
      referrerPolicy="no-referrer"
    />
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

const CanvasEmptyGlyph = () => (
  <svg
    className="canvas-tab__hero-empty-glyph"
    viewBox="0 0 48 48"
    fill="none"
    aria-hidden
  >
    <rect
      x="6"
      y="9"
      width="36"
      height="30"
      rx="4"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path
      d="M13 30l7-8 5 5 4-4 6 7"
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
  const [confirmRemove, setConfirmRemove] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    },
    [],
  );

  const handleRemoveClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    if (!confirmRemove) {
      setConfirmRemove(true);
      confirmTimerRef.current = setTimeout(
        () => setConfirmRemove(false),
        3000,
      );
      return;
    }
    confirmTimerRef.current = null;
    setConfirmRemove(false);
    removeCanvasHtmlItem(item.filePath);
  };

  return (
    <div
      className={
        isActive
          ? "canvas-tab__tile canvas-tab__tile--active"
          : "canvas-tab__tile"
      }
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
        className={
          confirmRemove
            ? "canvas-tab__tile-remove canvas-tab__tile-remove--confirm"
            : "canvas-tab__tile-remove"
        }
        onClick={handleRemoveClick}
        aria-label={
          confirmRemove ? "Click again to remove" : `Remove ${item.title}`
        }
        title={confirmRemove ? "Click again to remove" : "Remove"}
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
            <CanvasEmptyGlyph />
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
