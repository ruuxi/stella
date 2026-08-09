/**
 * AskStellaSelectionChip — floating "Ask Stella" pill that appears above
 * any text selection inside the Stella renderer.
 *
 * Click opens the panel chat with the selection attached as a
 * SelectedTextChip via the standard chat-context broadcast. A companion copy
 * icon button to the pill's right copies the same text to the clipboard (icon
 * swaps to a checkmark briefly, matching MessageActions' copy feedback).
 *
 * Hidden in any of the following surfaces (where a chip would either be
 * redundant or actively get in the user's way):
 *   - The composer textarea / chip strip
 *   - The panel chat
 *   - Any input/textarea/contenteditable
 *   - Anything marked `[data-stella-chrome]`
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "@/ui/icons";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { dispatchComposeText } from "@/shared/lib/stella-orb-chat";
import "./ask-stella-selection-chip.css";

const PILL_HEIGHT = 28;
const PILL_OFFSET = 8;
const PILL_MIN_WIDTH = 88;
const VIEWPORT_MARGIN = 6;
const MIN_CHARS = 2;
/** Copy icon button + gap to the pill's right — included when clamping. */
const COPY_BUTTON_EXTENT = 28 + 6;
const COPIED_RESET_MS = 1200;

type ChipState = {
  text: string;
  left: number;
  top: number;
  source?: Window | null;
};

type CanvasSelectionMessage = {
  type: "stella:canvas-selection";
  selected?: boolean;
  text?: unknown;
  rect?: unknown;
};

type CanvasComposeMessage = {
  type: "stella:canvas-compose";
  text?: unknown;
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
  const left = clampLeft(
    centerX - pillWidth / 2,
    pillWidth + COPY_BUTTON_EXTENT,
  );
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

const isCanvasSelectionMessage = (
  value: unknown,
): value is CanvasSelectionMessage =>
  Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "stella:canvas-selection");

const isCanvasComposeMessage = (
  value: unknown,
): value is CanvasComposeMessage =>
  Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "stella:canvas-compose");

const findCanvasIframe = (source: MessageEventSource | null): HTMLIFrameElement | null => {
  if (!source) return null;
  for (const iframe of document.querySelectorAll<HTMLIFrameElement>(
    ".canvas-tab__iframe",
  )) {
    if (iframe.contentWindow === source) return iframe;
  }
  return null;
};

const readCanvasSelectionState = (
  event: MessageEvent,
): ChipState | null | undefined => {
  if (!isCanvasSelectionMessage(event.data)) return undefined;
  if (!event.data.selected) return null;
  const iframe = findCanvasIframe(event.source);
  if (!iframe) return null;
  const text = typeof event.data.text === "string" ? event.data.text : "";
  if (text.trim().length < MIN_CHARS) return null;
  const rect =
    event.data.rect && typeof event.data.rect === "object"
      ? (event.data.rect as Record<string, unknown>)
      : null;
  const left = typeof rect?.left === "number" ? rect.left : null;
  const top = typeof rect?.top === "number" ? rect.top : null;
  const width = typeof rect?.width === "number" ? rect.width : null;
  const height = typeof rect?.height === "number" ? rect.height : null;
  if (left === null || top === null || width === null || height === null) {
    return null;
  }
  const iframeRect = iframe.getBoundingClientRect();
  const selectionRect = new DOMRect(
    iframeRect.left + left,
    iframeRect.top + top,
    width,
    height,
  );
  const position = computePillPosition(selectionRect);
  return { text, ...position, source: iframe.contentWindow };
};

export function AskStellaSelectionChip() {
  const [chip, setChip] = useState<ChipState | null>(null);
  const [copied, setCopied] = useState(false);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingClickRef = useRef(false);

  useEffect(() => {
    setCopied(false);
  }, [chip]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

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
    const onMessage = (event: MessageEvent) => {
      if (pendingClickRef.current) return;
      if (isCanvasComposeMessage(event.data)) {
        const iframe = findCanvasIframe(event.source);
        const text = typeof event.data.text === "string" ? event.data.text.trim() : "";
        if (iframe && text.length > 0) {
          setChip(null);
          dispatchComposeText({ text, selectedText: null });
        }
        return;
      }
      const next = readCanvasSelectionState(event);
      if (next !== undefined) setChip(next);
    };

    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("message", onMessage);

    return () => {
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("message", onMessage);
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
        chip.source?.postMessage({ type: "stella:canvas-selection-clear" }, "*");
      } catch {
        /* selection may not be removable in some hosts */
      }

      const electronApi = window.electronAPI;
      const capture = electronApi?.capture;
      const chatContext = {
        window: null,
        browserUrl: null,
        selectedText: text,
        regionScreenshots: [],
      };
      if (capture?.setContext) {
        capture.setContext(chatContext);
      }

      dispatchComposeText({ text: "", chatContext, selectedText: text });

      window.setTimeout(() => {
        pendingClickRef.current = false;
      }, 0);
    },
    [chip],
  );

  const handleCopy = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const text = chip?.text;
      if (!text) return;

      const ok = await copyTextToClipboard(text);
      if (!ok) {
        console.warn("[ask-stella-selection-chip] copy failed");
        return;
      }
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(
        () => setCopied(false),
        COPIED_RESET_MS,
      );
    },
    [chip],
  );

  if (!chip) return null;

  return (
    <div
      ref={chipRef}
      className="ask-stella-selection-chip-group"
      style={{ left: chip.left, top: chip.top }}
    >
      <button
        type="button"
        className="floating-selection-chip ask-stella-selection-chip"
        onMouseDown={(event) => event.preventDefault()}
        onClick={handleClick}
        title="Ask Stella about this selection"
      >
        <img
          src="stella-logo.png"
          alt=""
          aria-hidden="true"
          className="floating-selection-chip__logo ask-stella-selection-chip__logo"
        />
        <span className="floating-selection-chip__label ask-stella-selection-chip__label">
          Ask Stella
        </span>
      </button>
      <button
        type="button"
        className="floating-selection-chip ask-stella-selection-chip ask-stella-selection-chip--icon"
        onMouseDown={(event) => event.preventDefault()}
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? (
          <Check size={14} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Copy size={14} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
