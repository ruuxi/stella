/**
 * Canvas tab — workspace-panel viewer for HTML artifacts the orchestrator
 * produced via the `html` tool.
 *
 * Layout mirrors the Media tab: an action bar on top, a hero frame in the
 * middle, and a horizontal rail of sibling thumbnails along the bottom.
 * The hero is a sandboxed iframe rendering the file as `srcdoc` so the
 * canvas can run its own scripts without leaking globals into the
 * renderer; tile thumbnails are static glyph + title placeholders (no
 * iframe, no script execution) so a session with N canvases doesn't keep
 * N JS realms alive in the rail.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowUpRight, Sparkles, Trash2 } from "lucide-react";
import { displayTabs } from "../tab-store";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import {
  type CanvasHtmlItem,
  getCanvasHtmlItems,
  removeCanvasHtmlItem,
  subscribeCanvasHtmlItems,
} from "./canvas-items";
import { CanvasIllustration } from "../illustrations/CanvasIllustration";
import "./canvas-tab.css";

const decoder = new TextDecoder("utf-8");

/**
 * "Create app" prompt fed back into the chat composer when the user wants
 * to promote a canvas into a real Stella app. Phrasing keeps the user-
 * visible message normie-friendly while still pinning the file path so
 * the orchestrator can route it to a general agent without guessing.
 */
const createAppPrompt = (item: CanvasHtmlItem): string =>
  `Build this canvas as a real Stella app. Use it as the design and behavior reference: ${item.filePath}`;

/**
 * Hero variant: always live (the user is looking right at it).
 */
const CanvasHeroFrame = ({ item }: { item: CanvasHtmlItem }) => {
  const { bytes, error, loading } = useDisplayFileBytes(
    item.filePath,
    "Canvas preview requires the Stella desktop app.",
  );
  const html = useMemo(() => (bytes ? decoder.decode(bytes) : ""), [bytes]);

  if (error) {
    return (
      <div className="canvas-tab__frame-state canvas-tab__frame-state--hero">
        Couldn't load canvas
      </div>
    );
  }
  if (loading || !html) {
    return (
      <div className="canvas-tab__frame-state canvas-tab__frame-state--hero">
        Loading…
      </div>
    );
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

/**
 * Tile variant — static glyph + title pattern. Live iframe rendering at
 * thumbnail size was running every canvas's scripts (and re-running them
 * any time the rail re-mounted), so a session with several artifacts kept
 * just as many JS realms alive in the background. The rail is a navigator,
 * not a preview surface — the hero already shows the live canvas — so we
 * paint a lightweight tile decorated with the same canvas glyph used in
 * the display tab strip and call it done. Cheap enough to render dozens
 * of tiles without measurable cost.
 */
const CanvasTileFrame = ({ isActive }: { isActive: boolean }) => (
  <span
    className={
      isActive
        ? "canvas-tab__tile-frame canvas-tab__tile-frame--active"
        : "canvas-tab__tile-frame"
    }
    aria-hidden
  >
    <CanvasTileGlyph />
  </span>
);

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
      rx="2.2"
      stroke="currentColor"
      strokeOpacity="0.55"
      strokeWidth="1.4"
      fill="currentColor"
      fillOpacity="0.06"
    />
    <path
      d="M4 9h16"
      stroke="currentColor"
      strokeOpacity="0.45"
      strokeWidth="1.2"
    />
    <circle cx="6.5" cy="7" r="0.7" fill="currentColor" fillOpacity="0.5" />
    <circle cx="9" cy="7" r="0.7" fill="currentColor" fillOpacity="0.35" />
    <path
      d="M7 13h10M7 16h7"
      stroke="currentColor"
      strokeOpacity="0.35"
      strokeWidth="1.1"
      strokeLinecap="round"
    />
  </svg>
);

const useCanvasItems = (
  initial: ReadonlyArray<CanvasHtmlItem>,
): ReadonlyArray<CanvasHtmlItem> => {
  // External-store subscription keeps the rail and hero in sync with
  // any new canvases the orchestrator emits while the panel is open.
  // The snapshot getter returns a stable cached reference between
  // mutations so React doesn't think the store is constantly changing.
  return useSyncExternalStore(
    subscribeCanvasHtmlItems,
    getCanvasHtmlItems,
    () => initial,
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

  const handleDelete = useCallback(
    (id: string) => {
      removeCanvasHtmlItem(id);
    },
    [],
  );

  const expandPanel = useCallback(() => {
    displayTabs.setPanelExpanded(true);
  }, []);

  const handleCreateApp = useCallback(() => {
    if (!selectedItem) return;
    window.dispatchEvent(
      new CustomEvent("stella:send-message", {
        detail: { text: createAppPrompt(selectedItem) },
      }),
    );
  }, [selectedItem]);

  return (
    <div className="canvas-tab">
      <div className="canvas-tab__top">
        {selectedItem ? (
          <>
            <div className="canvas-tab__title-group">
              <span className="canvas-tab__eyebrow">Canvas</span>
              <div className="canvas-tab__title" title={selectedItem.title}>
                {selectedItem.title}
              </div>
            </div>
            <div className="canvas-tab__actions">
              <button
                type="button"
                className="canvas-tab__action canvas-tab__action--primary"
                onClick={handleCreateApp}
                title="Build this canvas as a real app"
              >
                <Sparkles size={14} strokeWidth={1.85} />
                <span>Create app</span>
              </button>
              <button
                type="button"
                className="canvas-tab__action"
                onClick={expandPanel}
                aria-label="Expand canvas"
                title="Expand"
              >
                <ArrowUpRight size={14} strokeWidth={1.85} />
              </button>
              <button
                type="button"
                className="canvas-tab__action canvas-tab__action--danger"
                onClick={() => handleDelete(selectedItem.id)}
                aria-label="Remove from canvas list"
                title="Remove from canvas list"
              >
                <Trash2 size={14} strokeWidth={1.85} />
              </button>
            </div>
          </>
        ) : null}
      </div>

      <div className="canvas-tab__hero">
        {selectedItem ? (
          <CanvasHeroFrame item={selectedItem} />
        ) : (
          <div className="canvas-tab__hero-empty">
            <div style={{ width: 160, height: 120, margin: "0 auto 16px", opacity: 0.9 }}>
              <CanvasIllustration />
            </div>
            <div className="canvas-tab__hero-empty-title">No canvases yet</div>
            <div className="canvas-tab__hero-empty-hint" style={{ fontSize: 15 }}>
              Ask Stella to plan, compare, sketch, or chart something — answers
              that don't fit in plain text show up here.
            </div>
          </div>
        )}
      </div>

      {items.length > 0 && (
        <div className="canvas-tab__rail" aria-label="Saved canvases">
          {items.map((item) => {
            const isActive = item.id === selectedItem?.id;
            return (
              <button
                key={item.id}
                type="button"
                className={
                  isActive
                    ? "canvas-tab__tile canvas-tab__tile--active"
                    : "canvas-tab__tile"
                }
                onClick={() => setSelectedId(item.id)}
                onDoubleClick={expandPanel}
                title={item.title}
                aria-label={item.title}
              >
                <CanvasTileFrame isActive={isActive} />
                <span className="canvas-tab__tile-label">{item.title}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
