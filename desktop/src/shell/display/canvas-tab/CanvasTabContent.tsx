/**
 * Canvas tab — workspace-panel viewer for HTML artifacts the orchestrator
 * produced via the `html` tool.
 *
 * Layout mirrors the Media tab: an action bar on top, a hero frame in the
 * middle, and a horizontal rail of sibling thumbnails along the bottom.
 * The hero is a sandboxed iframe rendering the file as `srcdoc` so the
 * canvas can run its own scripts without leaking globals into the
 * renderer; tile thumbnails reuse the same iframe approach but only
 * mount the live frame when the tile is actually visible (so a session
 * with N canvases doesn't keep N JS realms alive in the rail).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ArrowUpRight, Sparkles, Trash2 } from "lucide-react";
import { displayTabs } from "../tab-store";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import { useHasBeenVisible } from "@/shared/hooks/use-has-been-visible";
import {
  type CanvasHtmlItem,
  getCanvasHtmlItems,
  removeCanvasHtmlItem,
  subscribeCanvasHtmlItems,
} from "./canvas-items";
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
 * Tile variant. Until the tile scrolls into view we paint a lightweight
 * placeholder — no IPC read, no Blob, no iframe — so a session with
 * dozens of canvases doesn't keep dozens of live JS realms alive in
 * the rail. The active item never paints a tile iframe at all because
 * the hero already shows the live canvas.
 */
const CanvasTileFrame = ({
  item,
  isActive,
}: {
  item: CanvasHtmlItem;
  isActive: boolean;
}) => {
  const slotRef = useRef<HTMLSpanElement | null>(null);
  // The active tile mirrors the hero, so there's no point booting up a
  // second iframe for the same file. Show a static "active" indicator.
  // Non-active tiles wait until they scroll into view.
  const visible = useHasBeenVisible(slotRef);
  const shouldMountFrame = !isActive && visible;

  return (
    <span ref={slotRef} className="canvas-tab__tile-frame" aria-hidden>
      {shouldMountFrame ? (
        <CanvasTileIframe item={item} />
      ) : (
        <CanvasTilePlaceholder active={isActive} />
      )}
    </span>
  );
};

const CanvasTilePlaceholder = ({ active }: { active: boolean }) => (
  <span
    className={
      active
        ? "canvas-tab__frame-state canvas-tab__frame-state--tile canvas-tab__frame-state--active"
        : "canvas-tab__frame-state canvas-tab__frame-state--tile"
    }
  />
);

const CanvasTileIframe = ({ item }: { item: CanvasHtmlItem }) => {
  const { bytes, error, loading } = useDisplayFileBytes(
    item.filePath,
    "Canvas preview requires the Stella desktop app.",
  );
  const html = useMemo(() => (bytes ? decoder.decode(bytes) : ""), [bytes]);
  if (error || loading || !html) {
    return <CanvasTilePlaceholder active={false} />;
  }
  return (
    <iframe
      key={`${item.id}:${item.createdAt}`}
      title={item.title}
      className="canvas-tab__tile-iframe"
      srcDoc={html}
      sandbox="allow-scripts allow-popups allow-modals allow-forms"
      referrerPolicy="no-referrer"
      loading="lazy"
    />
  );
};

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
            <div className="canvas-tab__hero-empty-title">No canvases yet</div>
            <div className="canvas-tab__hero-empty-hint">
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
                <CanvasTileFrame item={item} isActive={isActive} />
                <span className="canvas-tab__tile-label">{item.title}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
