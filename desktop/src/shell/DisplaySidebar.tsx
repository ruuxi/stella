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
  type DisplayPayload,
  normalizeDisplayPayload,
} from "@/shared/contracts/display-payload";
import {
  DISPLAY_PANEL_MAX_RATIO,
  DISPLAY_PANEL_MAX_RESERVED_PX,
  DISPLAY_PANEL_MIN_WIDTH,
  displayTabs,
  useActiveDisplayTab,
  useDisplayTabs,
} from "./display/tab-store";
import { payloadToTabSpec } from "./display/payload-to-tab-spec";
import { DisplayTabBar } from "./display/DisplayTabBar";
import "./display-sidebar.css";

export interface DisplaySidebarHandle {
  /**
   * Open (or refresh) a tab for the given payload and activate it. The
   * panel auto-opens as a side effect of `displayTabs.openTab`. Strings
   * are accepted for legacy compatibility with the runtime worker's
   * `displayHtml(...)` IPC, which still streams raw HTML.
   */
  open(payload: DisplayPayload | string): void;
  /**
   * Refresh a tab's content without forcing the panel open or stealing
   * focus from another active tab.
   */
  update(payload: DisplayPayload | string): void;
  /** Close the panel; tabs are kept in memory for the next open. */
  close(): void;
}

type DisplaySidebarProps = {
  onOpenChange?: (open: boolean) => void;
};

/**
 * Compute the current upper bound for the user-resizable width. Capped at
 * `DISPLAY_PANEL_MAX_RATIO` of the viewport on wide windows so the panel
 * always leaves a usable chat column; falls back to the absolute reserve
 * on narrow windows. The expand toggle is the right tool for the
 * "fully take over" case.
 */
const computeMaxWidth = (): number => {
  const viewport = window.innerWidth;
  const softCap = Math.floor(viewport * DISPLAY_PANEL_MAX_RATIO);
  const hardCap = viewport - DISPLAY_PANEL_MAX_RESERVED_PX;
  return Math.max(DISPLAY_PANEL_MIN_WIDTH, Math.min(softCap, hardCap));
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
  const { panelOpen, panelExpanded, panelWidth, tabs } = useDisplayTabs();
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
        {tabs.length > 0 && <DisplayTabBar />}

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
