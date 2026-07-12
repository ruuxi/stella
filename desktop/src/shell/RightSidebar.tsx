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
import { resolveDisplayTabKeepAlive } from "@/features/workspace-display/display-tab-keep-alive";
import { payloadToTabSpec } from "./display/payload-to-tab-spec";
import {
  dispatchClosePanel,
  dispatchOpenWorkspacePanel,
} from "@/shared/lib/stella-orb-chat";
import { getPlatform } from "@/platform/electron/platform";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { DisplayPanelControls } from "@/shell/DisplayPanelControls";
import { DisplayTabSwitcher } from "@/shell/display/DisplayTabSwitcher";
import { CanvasTopBarTabs } from "@/shell/display/canvas-tab/CanvasTopBarTabs";
import "./right-sidebar.css";
import "./right-sidebar-panel.css";
import "./shell-junction.css";

export interface RightSidebarHandle {
  /**
   * User-initiated open (or refresh) for a payload tab. Activates the tab and
   * opens the panel through `displayTabs.openTab`.
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

type RightSidebarProps = {
  portalTarget?: Element | null;
};

const DISPLAY_PANEL_DEFAULT_WIDTH = 600;

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const computeDefaultWidth = (): number => DISPLAY_PANEL_DEFAULT_WIDTH;

const measureShellWidth = (): number => {
  const shell = document.querySelector<HTMLElement>(".full-body");
  return shell?.getBoundingClientRect().width ?? window.innerWidth;
};

const measureDockedLeftSidebarWidth = (): number => {
  const sidebar = document.querySelector<HTMLElement>(".left-sidebar");
  return sidebar?.getBoundingClientRect().width ?? 0;
};

/**
 * Compute the current upper bound for the user-resizable width from the
 * shell width after reserving the docked left sidebar and the main outlet's
 * minimum width. This mirrors Codex's pressure behavior: the right panel
 * shrinks and grows with the app window instead of holding a fixed width
 * until it disappears.
 */
const computeMaxWidth = (): number => {
  const available =
    measureShellWidth() -
    measureDockedLeftSidebarWidth() -
    DISPLAY_MAIN_CONTENT_MIN_WIDTH;
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

// Last rounded px written per `:root`, shared by every writer (RO sync,
// pointer drags) so redundant writes can be skipped — re-setting an inline
// custom property on the root invalidates style for every `var()` consumer,
// and during the left sidebar's 460ms width slide the ResizeObserver below
// fires on every animation frame. Keyed by the document element (not module
// state) so multiple documents in one JS context — e.g. a detached panel
// window — each track their own last-written value instead of suppressing
// each other's writes.
const lastAppliedDisplayPanelWidthPx = new WeakMap<HTMLElement, number>();

// Set on `:root` (not on `.right-sidebar`) so siblings outside the panel
// (e.g. the topbar tab strip width calc) can inherit the same value.
const applyDisplayPanelWidthCssVar = (width: number | null): void => {
  const root = document.documentElement;
  const nextWidth = Math.round(resolveDisplayPanelWidth(width));
  if (lastAppliedDisplayPanelWidthPx.get(root) === nextWidth) return;
  lastAppliedDisplayPanelWidthPx.set(root, nextWidth);
  root.style.setProperty(DISPLAY_PANEL_WIDTH_CSS_VAR, `${nextWidth}px`);
};

const clearDisplayPanelWidthCssVar = (): void => {
  const root = document.documentElement;
  lastAppliedDisplayPanelWidthPx.delete(root);
  root.style.removeProperty(DISPLAY_PANEL_WIDTH_CSS_VAR);
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
export const RightSidebar = forwardRef<
  RightSidebarHandle,
  RightSidebarProps
>(function RightSidebar({ portalTarget }, ref) {
  const panelOpen = useDisplayPanelOpen();
  const panelExpanded = useDisplayPanelExpanded();
  const activeTab = useActiveDisplayTab();
  const asideRef = useRef<HTMLElement | null>(null);
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const isMiniWindow = useWindowType() === "mini";

  // Viewer-only: the panel is just the detail surface. It's mounted only
  // when open (with an active viewer); the index lives in the left sidebar.
  const shellVisible = panelOpen;

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
      // An Escape already handled by a menu/dialog shouldn't also collapse the
      // panel.
      if (e.defaultPrevented) return;
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

  useLayoutEffect(() => {
    let frame = 0;
    const syncWidthVarNow = () => {
      frame = 0;
      applyDisplayPanelWidthCssVar(displayTabs.getLayoutSnapshot().panelWidth);
    };

    const scheduleWidthVarSync = () => {
      // While the panel is closed nothing consumes the var, so re-measuring
      // the shell + left sidebar on every ResizeObserver tick (a forced
      // layout per animation frame during the left sidebar's width slide)
      // is wasted work. `syncOnLayoutChange` below refreshes the var the
      // moment the panel opens, so it can never go stale for an open panel.
      if (!displayTabs.getLayoutSnapshot().panelOpen) return;
      if (frame !== 0) return;
      frame = requestAnimationFrame(syncWidthVarNow);
    };

    // Store changes (open/close, width commits) sync immediately instead of
    // via rAF so the var is fresh before the open transition's first paint —
    // a deferred sync would let the panel start animating toward a width
    // measured while it was closed.
    const syncOnLayoutChange = () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      syncWidthVarNow();
    };

    syncWidthVarNow();
    const unsubscribe = displayTabs.subscribeLayout(syncOnLayoutChange);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleWidthVarSync);
    const shell = document.querySelector<HTMLElement>(".full-body");
    const leftSidebar =
      document.querySelector<HTMLElement>(".left-sidebar");
    if (shell) resizeObserver?.observe(shell);
    if (leftSidebar) resizeObserver?.observe(leftSidebar);
    window.addEventListener("resize", scheduleWidthVarSync);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      resizeObserver?.disconnect();
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
      aside?.classList.add("right-sidebar--resizing");
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
        aside?.classList.remove("right-sidebar--resizing");
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

  const resolvedPortalTarget =
    portalTarget ?? document.querySelector(".full-body") ?? document.body;

  // Canvas keep-alive: closing the panel used to unmount the active tab,
  // which destroys a canvas iframe's browsing context — reopening re-parsed
  // the document, re-ran scripts, refetched CDN assets, and lost all state.
  // Keep the just-viewed canvas mounted in a hidden host instead (policy in
  // resolveDisplayTabKeepAlive); every other tab kind unmounts on close
  // exactly as before.
  const lastRenderedTabIdRef = useRef<string | null>(null);
  const { renderedTab, lastRenderedTabId } = resolveDisplayTabKeepAlive({
    panelOpen,
    activeTab,
    lastRenderedTabId: lastRenderedTabIdRef.current,
  });
  lastRenderedTabIdRef.current = lastRenderedTabId;

  return createPortal(
    <aside
      ref={asideRef}
      className={`right-sidebar right-sidebar-panel${
        shellVisible ? " right-sidebar--shell-visible" : ""
      }${panelOpen ? " right-sidebar--open" : ""}${
        panelOpen && panelExpanded ? " right-sidebar--expanded" : ""
      }`}
      aria-label="Workspace"
      aria-hidden={!shellVisible}
      onContextMenu={handleContextMenu}
    >
      {panelOpen ? (
        <div
          className="right-sidebar__resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize display panel"
          onPointerDown={handleResizeStart}
          onDoubleClick={handleResizeDoubleClick}
          title="Drag to resize · double-click to reset"
        />
      ) : null}
      <div className="right-sidebar-inner right-sidebar-panel__frame">
        {panelOpen && !isMiniWindow ? (
          <div
            className="right-sidebar-panel__chrome"
            data-platform={isMac ? "mac" : isWin ? "win" : "other"}
          >
            <div className="right-sidebar-panel__chrome-tabs-slot">
              <DisplayTabSwitcher />
              <CanvasTopBarTabs />
            </div>
            <DisplayPanelControls />
          </div>
        ) : null}
        <div className="right-sidebar-panel__body">
          {renderedTab ? (
            <div
              className={`right-sidebar__active${
                panelOpen ? "" : " right-sidebar__active--kept"
              }`}
            >
              <DeferredDisplayContent
                key={renderedTab.id}
                render={renderedTab.render}
              />
            </div>
          ) : null}
        </div>
      </div>
    </aside>,
    resolvedPortalTarget,
  );
});
