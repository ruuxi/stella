/**
 * AskStellaSelectionChip — floating "Ask Stella" pill that appears above
 * any text selection inside the Stella renderer.
 *
 * Click opens the panel chat with the selection attached as a
 * SelectedTextChip via the standard chat-context broadcast (mirrors the
 * radial gesture's path).
 *
 * Hidden in any of the following surfaces (where a chip would either be
 * redundant or actively get in the user's way):
 *   - The composer textarea / chip strip
 *   - The panel chat
 *   - Any input/textarea/contenteditable
 *   - Anything marked `[data-stella-chrome]`
 *
 * For the global ("anywhere on the user's computer") variant see
 * `desktop/electron/services/selection-watcher-service.ts` + the overlay
 * window's SelectionChipOverlay.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { router } from "@/router";
import { dispatchOpenPanelChat } from "@/shared/lib/stella-orb-chat";
import "./ask-stella-selection-chip.css";

const PILL_HEIGHT = 28;
const PILL_OFFSET = 8;
const PILL_MIN_WIDTH = 88;
const VIEWPORT_MARGIN = 6;
const MIN_CHARS = 2;

type ChipState = {
  text: string;
  left: number;
  top: number;
};

const SELECTION_HIDE_SELECTORS = [
  "input",
  "textarea",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[contenteditable]:not([contenteditable='false'])",
  ".composer",
  ".chat-panel-tab",
  ".chat-sidebar",
  ".chat-sidebar-shell",
  "[data-stella-chrome]",
] as const;

const isInsideHiddenSurface = (node: Node | null): boolean => {
  if (!node) return false;
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  if (!element) return false;
  return SELECTION_HIDE_SELECTORS.some((selector) => element.closest(selector));
};

const clampLeft = (rawLeft: number, pillWidth: number): number => {
  const maxLeft = window.innerWidth - pillWidth - VIEWPORT_MARGIN;
  return Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, maxLeft));
};

const clampTop = (rawTop: number): number => {
  if (rawTop < VIEWPORT_MARGIN) {
    return VIEWPORT_MARGIN;
  }
  const maxTop = window.innerHeight - PILL_HEIGHT - VIEWPORT_MARGIN;
  return Math.min(rawTop, maxTop);
};

const computePillPosition = (rect: DOMRect): { left: number; top: number } => {
  const pillWidth = Math.max(PILL_MIN_WIDTH, rect.width * 0.5);
  const centerX = rect.left + rect.width / 2;
  const left = clampLeft(centerX - pillWidth / 2, pillWidth);
  const naturalTop = rect.top - PILL_HEIGHT - PILL_OFFSET;
  const top =
    naturalTop < VIEWPORT_MARGIN ? rect.bottom + PILL_OFFSET : naturalTop;
  return { left, top: clampTop(top) };
};

const readSelectionState = (): ChipState | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const text = selection.toString();
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (isInsideHiddenSurface(range.commonAncestorContainer)) {
    return null;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }

  const { left, top } = computePillPosition(rect);
  return { text, left, top };
};

export function AskStellaSelectionChip() {
  const [chip, setChip] = useState<ChipState | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const pendingClickRef = useRef(false);

  const refreshFromSelection = useCallback(() => {
    if (pendingClickRef.current) return;
    const next = readSelectionState();
    setChip(next);
  }, []);

  useEffect(() => {
    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (
        chipRef.current &&
        event.target instanceof Node &&
        chipRef.current.contains(event.target)
      ) {
        return;
      }
      requestAnimationFrame(refreshFromSelection);
    };

    const onMouseDown = (event: MouseEvent) => {
      if (
        chipRef.current &&
        event.target instanceof Node &&
        chipRef.current.contains(event.target)
      ) {
        return;
      }
      setChip(null);
    };

    const onSelectionChange = () => {
      if (pendingClickRef.current) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setChip(null);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChip(null);
    };

    const onScroll = () => setChip(null);

    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);

    return () => {
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [refreshFromSelection]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const text = chip?.text;
      if (!text) {
        setChip(null);
        return;
      }

      pendingClickRef.current = true;
      setChip(null);

      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* selection may not be removable in some hosts */
      }

      const electronApi = window.electronAPI;
      const capture = electronApi?.capture;
      if (capture?.setContext) {
        capture.setContext({
          window: null,
          browserUrl: null,
          selectedText: text,
          regionScreenshots: [],
        });
      }

      if (router.state.location.pathname !== "/chat") {
        dispatchOpenPanelChat();
      }

      window.setTimeout(() => {
        pendingClickRef.current = false;
      }, 0);
    },
    [chip?.text],
  );

  if (!chip) return null;

  return (
    <button
      ref={chipRef}
      type="button"
      className="floating-selection-chip ask-stella-selection-chip"
      style={{ left: chip.left, top: chip.top }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={handleClick}
      title="Ask Stella about this selection"
    >
      <img
        src="stella-logo.svg"
        alt=""
        aria-hidden="true"
        className="floating-selection-chip__logo ask-stella-selection-chip__logo"
      />
      <span className="floating-selection-chip__label ask-stella-selection-chip__label">
        Ask Stella
      </span>
    </button>
  );
}
