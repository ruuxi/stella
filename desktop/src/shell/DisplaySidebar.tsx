import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
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
  useDisplayPanelExpanded,
  useDisplayPanelOpen,
} from "@/features/workspace-display/tab-store";
import { payloadToTabSpec } from "./display/payload-to-tab-spec";
import {
  dispatchClosePanel,
  dispatchOpenWorkspacePanel,
} from "@/shared/lib/stella-orb-chat";
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

const DISPLAY_PANEL_DEFAULT_MIN_WIDTH = 380;
const DISPLAY_PANEL_DEFAULT_MAX_WIDTH = 520;
const DISPLAY_PANEL_DEFAULT_VIEWPORT_RATIO = 0.34;

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const computeDefaultWidth = (): number =>
  clampNumber(
    window.innerWidth * DISPLAY_PANEL_DEFAULT_VIEWPORT_RATIO,
    DISPLAY_PANEL_DEFAULT_MIN_WIDTH,
    DISPLAY_PANEL_DEFAULT_MAX_WIDTH,
  );

/**
 * Compute the current upper bound for the user-resizable width from the
 * main outlet's minimum width. The panel can grow as much as it wants until
 * it would squeeze the main content below that floor.
 */
const computeMaxWidth = (): number => {
  const available = window.innerWidth - DISPLAY_MAIN_CONTENT_MIN_WIDTH;
  return Math.max(DISPLAY_PANEL_MIN_WIDTH, Math.floor(available));
};

const resolveDisplayPanelWidth = (preferredWidth: number | null): number => {
  const desired = preferredWidth ?? computeDefaultWidth();
  return clampNumber(
    desired,
    DISPLAY_PANEL_MIN_WIDTH,
    Math.max(DISPLAY_PANEL_MIN_WIDTH, computeMaxWidth()),
  );
};

// Extra drag past the max resize width before snapping to expanded mode.
const DISPLAY_PANEL_EXPAND_SNAP_THRESHOLD = 260;
const DISPLAY_PANEL_WIDTH_CSS_VAR = "--display-panel-width";

// Set on `:root` (not on `.display-sidebar`) so siblings outside the panel
// (e.g. the topbar tab strip width calc) can inherit the same value.
const applyDisplayPanelWidthCssVar = (width: number | null): void => {
  const root = document.documentElement;
  const nextWidth = resolveDisplayPanelWidth(width);
  root.style.setProperty(
    DISPLAY_PANEL_WIDTH_CSS_VAR,
    `${Math.round(nextWidth)}px`,
  );
};

const clearDisplayPanelWidthCssVar = (): void => {
  document.documentElement.style.removeProperty(DISPLAY_PANEL_WIDTH_CSS_VAR);
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
  const panelOpen = useDisplayPanelOpen();
  const panelExpanded = useDisplayPanelExpanded();
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

  useLayoutEffect(() => {
    let frame = 0;
    const syncWidthVarNow = () => {
      frame = 0;
      applyDisplayPanelWidthCssVar(displayTabs.getLayoutSnapshot().panelWidth);
    };

    const scheduleWidthVarSync = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(syncWidthVarNow);
    };

    syncWidthVarNow();
    const unsubscribe = displayTabs.subscribeLayout(scheduleWidthVarSync);
    window.addEventListener("resize", scheduleWidthVarSync);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      window.removeEventListener("resize", scheduleWidthVarSync);
      clearDisplayPanelWidthCssVar();
    };
  }, []);

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

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Only respond to primary-button drags; ignore right-clicks and
      // touch contextmenu emulation.
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const aside = asideRef.current;
      const measuredStartWidth =
        aside?.getBoundingClientRect().width ??
        displayTabs.getSnapshot().panelWidth ??
        0;
      const startX = event.clientX;
      const pointerId = event.pointerId;
      const handle = event.currentTarget;
      // Compute the upper bound once at pointerdown — recomputing per
      // move would force a `getComputedStyle` layout flush at 60–120 Hz
      // for a value that doesn't change unless the OS window is
      // simultaneously resized (which is exceedingly rare during a
      // user-initiated panel drag).
      const maxWidth = computeMaxWidth();
      const startWidth = panelExpanded ? maxWidth : measuredStartWidth;
      // Keep the live drag on the CSS variable. Committing through React's
      // store every frame wakes route-level layout subscribers and makes the
      // handle trail the cursor. `latestWidth` doubles as the "user actually
      // dragged" signal — null means no commit needed on pointer up.
      let latestWidth: number | null = null;
      let frame = 0;
      let snappedToExpanded = panelExpanded;
      let collapsedFromExpanded = false;

      const applyLatestWidth = () => {
        frame = 0;
        if (latestWidth == null) return;
        applyDisplayPanelWidthCssVar(latestWidth);
      };

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
        if (collapsedFromExpanded) return;

        // Panel sits on the right edge, so dragging left increases width.
        const delta = startX - ev.clientX;
        const rawWidth = startWidth + delta;

        if (snappedToExpanded) {
          if (delta > -DISPLAY_PANEL_EXPAND_SNAP_THRESHOLD) return;
          snappedToExpanded = false;
          collapsedFromExpanded = true;
          latestWidth = maxWidth;
          applyDisplayPanelWidthCssVar(maxWidth);
          displayTabs.setPanelWidth(maxWidth);
          displayTabs.setPanelExpanded(false);
          return;
        }

        if (rawWidth >= maxWidth + DISPLAY_PANEL_EXPAND_SNAP_THRESHOLD) {
          snappedToExpanded = true;
          latestWidth = maxWidth;
          if (frame !== 0) {
            cancelAnimationFrame(frame);
            frame = 0;
          }
          applyDisplayPanelWidthCssVar(maxWidth);
          displayTabs.setPanelWidth(maxWidth);
          displayTabs.setPanelExpanded(true);
          return;
        }

        latestWidth = Math.max(
          DISPLAY_PANEL_MIN_WIDTH,
          Math.min(maxWidth, rawWidth),
        );
        if (frame === 0) {
          frame = requestAnimationFrame(applyLatestWidth);
        }
      };

      const onUp = () => {
        if (frame !== 0) {
          cancelAnimationFrame(frame);
          applyLatestWidth();
        }
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
        if (latestWidth != null) {
          displayTabs.setPanelWidth(latestWidth);
        }
        // Force any pending coalesced width to disk so the user's most
        // recent position survives a reload, even if the next debounce
        // tick was still in flight.
        displayTabs.flushPersistedWidth();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [panelExpanded],
  );

  const handleResizeDoubleClick = useCallback(() => {
    // Snap back to the stylesheet default.
    displayTabs.setPanelWidth(null);
  }, []);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();

      if (panelOpen) {
        dispatchClosePanel();
      } else {
        dispatchOpenWorkspacePanel();
      }
    },
    [panelOpen],
  );

  const portalTarget = document.querySelector(".full-body") ?? document.body;

  return createPortal(
    <aside
      ref={asideRef}
      className={`display-sidebar${panelOpen ? " display-sidebar--open" : ""}${
        panelOpen && panelExpanded ? " display-sidebar--expanded" : ""
      }`}
      aria-hidden={!panelOpen}
      onContextMenu={handleContextMenu}
    >
      <div
        className="display-sidebar__resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize display panel"
        onPointerDown={handleResizeStart}
        onDoubleClick={handleResizeDoubleClick}
        title="Drag to resize · double-click to reset"
      />
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
