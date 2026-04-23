import {
  forwardRef,
  useEffect,
  useImperativeHandle,
} from "react";
import { createPortal } from "react-dom";
import { useTheme } from "@/context/theme-context";
import {
  type DisplayPayload,
  normalizeDisplayPayload,
} from "@/shared/contracts/display-payload";
import { ShiftingGradient } from "./background/ShiftingGradient";
import { displayTabs, useActiveDisplayTab, useDisplayTabs } from "./display/tab-store";
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
   * focus from another active tab. Used by `useDisplayAutoRoute` when the
   * user is not on the chat home — we want to update the existing surface
   * but not pop the sidebar over their work.
   */
  update(payload: DisplayPayload | string): void;
  /** Close the panel; tabs are kept in memory for the next open. */
  close(): void;
}

type DisplaySidebarProps = {
  onOpenChange?: (open: boolean) => void;
};

/**
 * Display sidebar shell.
 *
 * Stateful tab list lives in the singleton `displayTabs` store so that
 * non-React surfaces (Convex materializer, IPC handlers, chat resource
 * pills) can register tabs with a single `displayTabs.openTab(spec)`
 * call. This component just observes the store and renders the active
 * tab's `render()`.
 */
export const DisplaySidebar = forwardRef<DisplaySidebarHandle, DisplaySidebarProps>(
  function DisplaySidebar({ onOpenChange }, ref) {
    const { gradientMode, gradientColor } = useTheme();
    const { panelOpen, tabs } = useDisplayTabs();
    const activeTab = useActiveDisplayTab();

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
        if (e.key === "Escape") displayTabs.setPanelOpen(false);
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [panelOpen]);

    useEffect(() => {
      onOpenChange?.(panelOpen);
    }, [panelOpen, onOpenChange]);

    const portalTarget =
      document.querySelector(".full-body") ?? document.body;

    return createPortal(
      <aside
        className={`display-sidebar${panelOpen ? " display-sidebar--open" : ""}`}
        aria-hidden={!panelOpen}
      >
        <ShiftingGradient
          mode={gradientMode}
          colorMode={gradientColor}
          contained
        />
        <div className="display-sidebar-inner">
          <button
            className="display-sidebar__close"
            onClick={() => displayTabs.setPanelOpen(false)}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>

          {tabs.length > 0 && <DisplayTabBar />}

          <div className="display-sidebar__active">
            {activeTab ? activeTab.render() : null}
          </div>
        </div>
      </aside>,
      portalTarget,
    );
  },
);
