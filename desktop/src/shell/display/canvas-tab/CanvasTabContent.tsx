/**
 * Canvas tab — hosts the canvas library site (`stella-canvas://library`),
 * the app-owned shell that lists, groups, and searches every page the
 * orchestrator's `html` tool has produced. The tab is a single persistent
 * iframe onto that site; new pages slot in via a manifest the tool
 * maintains, so this component only has to nudge the shell:
 *
 *   - `stella:library-refresh` when the canvas store sees a new payload
 *     (the shell refetches /manifest.json and animates the new card in)
 *   - `stella:library-open` to deep-link the page a chat artifact or a
 *     fresh html-tool result refers to
 *
 * Selection bridging ("Ask Stella" on selected canvas text) keeps working
 * unchanged: the shell relays the artifact iframe's selection messages to
 * this window with rect offsets applied, and `AskStellaSelectionChip`
 * still finds this iframe via the `.canvas-tab__iframe` class.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type CanvasHtmlItem,
  getCanvasHtmlItems,
  subscribeCanvasHtmlItems,
} from "./canvas-items";
import { CanvasIllustration } from "../illustrations/CanvasIllustration";
import "./canvas-tab.css";

export const CANVAS_LIBRARY_URL = "stella-canvas://library/";

const slugForItem = (
  items: ReadonlyArray<CanvasHtmlItem>,
  itemId: string,
): string | null => {
  const item = items.find((candidate) => candidate.id === itemId);
  if (item?.slug) return item.slug;
  const basename = itemId.split(/[\\/]/).pop() ?? "";
  return basename.endsWith(".html")
    ? basename.slice(0, -".html".length)
    : null;
};

const libraryShellSrc = (): string => {
  const theme = document.documentElement.getAttribute(
    "data-stella-boot-theme",
  );
  return theme === "dark" || theme === "light"
    ? `${CANVAS_LIBRARY_URL}?theme=${theme}`
    : CANVAS_LIBRARY_URL;
};

const CanvasIllustrationSpot = () => (
  <div className="canvas-tab__illustration-spot">
    <div className="canvas-tab__illustration-art">
      <CanvasIllustration />
    </div>
  </div>
);

const useCanvasItems = (
  initial: ReadonlyArray<CanvasHtmlItem>,
): ReadonlyArray<CanvasHtmlItem> =>
  useSyncExternalStore(
    subscribeCanvasHtmlItems,
    getCanvasHtmlItems,
    () => initial,
  );

export const CanvasTabContent = ({
  items: initialItems,
  selectedItemId,
}: {
  items: ReadonlyArray<CanvasHtmlItem>;
  selectedItemId?: string;
}) => {
  const items = useCanvasItems(initialItems);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [shellReady, setShellReady] = useState(false);
  const [shellSrc] = useState(libraryShellSrc);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.source === iframeRef.current?.contentWindow &&
        (event.data as { type?: unknown })?.type === "stella:library-ready"
      ) {
        setShellReady(true);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // New payloads bump the store snapshot (including same-slug rewrites,
  // which refresh createdAt); tell the shell to refetch the manifest.
  useEffect(() => {
    if (!shellReady) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: "stella:library-refresh" },
      "*",
    );
  }, [shellReady, items]);

  // Deep-link the page the latest payload refers to. `selectedItemId` only
  // changes when a payload (re)opens this tab, so user navigation inside
  // the shell is never fought by stale props.
  useEffect(() => {
    if (!shellReady || !selectedItemId) return;
    const slug = slugForItem(items, selectedItemId);
    if (!slug) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: "stella:library-open", slug },
      "*",
    );
    // items is intentionally not a dependency: re-opening on every store
    // bump would yank the user back to the latest page mid-browse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellReady, selectedItemId]);

  if (typeof window.electronAPI === "undefined") {
    return (
      <div className="canvas-tab">
        <div className="canvas-tab__hero">
          <div className="canvas-tab__hero-empty">
            <CanvasIllustrationSpot />
            <div className="canvas-tab__hero-empty-title">
              Canvases land here
            </div>
            <div className="canvas-tab__hero-empty-hint">
              The canvas library requires the Stella desktop app.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="canvas-tab">
      <div className="canvas-tab__hero">
        <div className="canvas-tab__frame-wrap">
          <iframe
            ref={iframeRef}
            title="Canvas library"
            className="canvas-tab__iframe"
            src={shellSrc}
            sandbox="allow-scripts allow-same-origin allow-popups allow-modals allow-forms"
            referrerPolicy="no-referrer"
          />
        </div>
      </div>
    </div>
  );
};
