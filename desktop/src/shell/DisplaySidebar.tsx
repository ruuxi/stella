import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  type DisplayTabPayload,
  normalizeDisplayPayload,
} from "@/shared/contracts/display-payload";
import {
  DISPLAY_MAIN_CONTENT_MIN_WIDTH,
  DISPLAY_PANEL_MIN_WIDTH,
  displayTabs,
  useActiveDisplayTab,
  useDisplayTabs,
} from "./display/tab-store";
import { payloadToTabSpec } from "./display/payload-to-tab-spec";
import "./display-sidebar.css";

export interface DisplaySidebarHandle {
  /**
   * Open (or refresh) a tab for the given payload and activate it. The
   * panel auto-opens as a side effect of `displayTabs.openTab`.
   */
  open(payload: DisplayTabPayload): void;
  /**
   * Refresh a tab's content without forcing the panel open or stealing
   * focus from another active tab.
   */
  update(payload: DisplayTabPayload): void;
  /** Close the panel; tabs are kept in memory for the next open. */
  close(): void;
}

type DisplaySidebarProps = {
  onOpenChange?: (open: boolean) => void;
};

const readShellSizeVar = (name: string, fallback: number): number => {
  const shell = document.querySelector<HTMLElement>(".window-shell.full");
  const raw = shell
    ? getComputedStyle(shell).getPropertyValue(name).trim()
    : "";
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Compute the current upper bound for the user-resizable width from the
 * main outlet's minimum width. The panel can grow as much as it wants until
 * it would squeeze the main content below that floor.
 */
const computeMaxWidth = (): number => {
  const viewport = window.innerWidth;
  const sidebarWidth =
    document.documentElement.dataset.sidebarRail === "true"
      ? readShellSizeVar("--shell-sidebar-rail-width", 82)
      : readShellSizeVar("--shell-sidebar-width", 170);
  const available = viewport - sidebarWidth - DISPLAY_MAIN_CONTENT_MIN_WIDTH;
  return Math.max(DISPLAY_PANEL_MIN_WIDTH, Math.floor(available));
};

const DeferredDisplayContent = ({ render }: { render: () => ReactNode }) => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return ready ? render() : null;
};

/**
 * workspace panel shell.
 *
 * Stateful tab list lives in the singleton `displayTabs` store so that
 * non-React surfaces (Convex materializer, IPC handlers, chat resource
 * pills) can register tabs with a single `displayTabs.openTab(spec)`
 * call. This component just observes the store and renders the active
 * tab's `render()`.
 */
export const DisplaySidebar = forwardRef<
  DisplaySidebarHandle,
  DisplaySidebarProps
>(function DisplaySidebar({ onOpenChange }, ref) {
  const { panelOpen, panelExpanded, panelWidth } = useDisplayTabs();
  const activeTab = useActiveDisplayTab();
  const asideRef = useRef<HTMLElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      open(rawPayload) {
        const next = normalizeDisplayPayload(rawPayload);
        if (!next) return;
        displayTabs.openTab(payloadToTabSpec(next));
      },
      update(rawPayload) {
        const next = normalizeDisplayPayload(rawPayload);
        if (!next) return;
        const spec = payloadToTabSpec(next);
        const { panelOpen } = displayTabs.getSnapshot();
        // Refresh the underlying tab without activating / opening the
        // panel. If the panel is already open and this tab happens to be
        // active, the new render() takes effect immediately. If the panel is
        // closed, make the updated tab the next active tab without reopening
        // the UI; the next explicit open will land on the freshest payload.
        displayTabs.openTab(
          spec,
          panelOpen
            ? { activate: false }
            : { activate: true, openPanel: false },
        );
      },
      close() {
        displayTabs.setPanelOpen(false);
      },
    }),
    [],
  );

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc collapses an expanded panel before fully closing it, so the
      // first press feels like "back out" and the second like "dismiss".
      if (displayTabs.getSnapshot().panelExpanded) {
        displayTabs.setPanelExpanded(false);
      } else {
        displayTabs.setPanelOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelOpen]);

  useEffect(() => {
    onOpenChange?.(panelOpen);
  }, [panelOpen, onOpenChange]);

  // Toggling expand/restore swaps the panel between flex-row and absolute
  // layout instantly (no width animation on the panel itself), so the
  // tab strip's open/close transition would visibly re-animate from its
  // expanded full-width slot back to the narrow right-aligned slot. Pin
  // a one-frame `data-display-expanding` flag on <body> so the topbar
  // CSS can suppress its transition through the swap, mirroring the
  // existing `data-display-resizing` pattern used during pointer drags.
  const isFirstExpandedSync = useRef(true);
  useEffect(() => {
    if (isFirstExpandedSync.current) {
      isFirstExpandedSync.current = false;
      return;
    }
    document.body.dataset.displayExpanding = "true";
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        delete document.body.dataset.displayExpanding;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      delete document.body.dataset.displayExpanding;
    };
  }, [panelExpanded]);

  // If the window shrinks below the user's chosen width, snap the stored
  // width down so we don't end up wider than the viewport allows.
  useEffect(() => {
    if (panelWidth == null) return;
    const onResize = () => {
      const max = computeMaxWidth();
      if (panelWidth > max) displayTabs.setPanelWidth(max);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [panelWidth]);

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Only respond to primary-button drags; ignore right-clicks and
      // touch contextmenu emulation.
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const aside = asideRef.current;
      const startWidth =
        aside?.getBoundingClientRect().width ?? panelWidth ?? 0;
      const startX = event.clientX;
      const pointerId = event.pointerId;
      const handle = event.currentTarget;

      // Pin the cursor / disable selection globally so dragging across
      // the chat outlet doesn't accidentally start a text selection.
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      aside?.classList.add("display-sidebar--resizing");
      // Lets the topbar (which lives in a separate React tree above the
      // panel) drop its open/close transition for the duration of the
      // drag — otherwise the centered store tabs and right-aligned tab
      // strip visibly lag the pointer.
      document.body.dataset.displayResizing = "true";

      const onMove = (ev: PointerEvent) => {
        // Panel sits on the right edge, so dragging left increases width.
        const delta = startX - ev.clientX;
        const max = computeMaxWidth();
        const next = Math.max(
          DISPLAY_PANEL_MIN_WIDTH,
          Math.min(max, startWidth + delta),
        );
        displayTabs.setPanelWidth(next);
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (handle.hasPointerCapture?.(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        aside?.classList.remove("display-sidebar--resizing");
        delete document.body.dataset.displayResizing;
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [panelWidth],
  );

  const handleResizeDoubleClick = useCallback(() => {
    // Snap back to the stylesheet default.
    displayTabs.setPanelWidth(null);
  }, []);

  const portalTarget = document.querySelector(".full-body") ?? document.body;

  // Inline CSS variable lets the stylesheet keep its `clamp()` default
  // when the user hasn't resized yet. While expanded, the class wins via
  // a higher-specificity rule (no need to clear the var).
  const widthStyle: CSSProperties | undefined =
    panelWidth != null
      ? ({ "--display-panel-width": `${panelWidth}px` } as CSSProperties)
      : undefined;

  return createPortal(
    <aside
      ref={asideRef}
      className={`display-sidebar${panelOpen ? " display-sidebar--open" : ""}${
        panelExpanded ? " display-sidebar--expanded" : ""
      }`}
      aria-hidden={!panelOpen}
      {...(widthStyle ? { style: widthStyle } : {})}
    >
      {/* Left-edge drag handle. Hidden visually while expanded since
            the panel already fills the space. */}
      {!panelExpanded && (
        <div
          className="display-sidebar__resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize display panel"
          onPointerDown={handleResizeStart}
          onDoubleClick={handleResizeDoubleClick}
          title="Drag to resize · double-click to reset"
        />
      )}
      <div className="display-sidebar-inner">
        <div className="display-sidebar__active">
          {panelOpen && activeTab ? (
            <DeferredDisplayContent
              key={activeTab.id}
              render={activeTab.render}
            />
          ) : null}
        </div>
      </div>
    </aside>,
    portalTarget,
  );
});
