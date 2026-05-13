import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Maximize2,
  Minimize2,
  Minus,
  PanelRight,
  Pin,
  Square,
  X,
} from "lucide-react";
import { getPlatform } from "@/platform/electron/platform";
import { useWindowType } from "@/shared/hooks/use-window-type";
import {
  displayTabs,
  useDisplayPanelLayout,
} from "@/shell/display/tab-store";
import { DisplayTabBar } from "@/shell/display/DisplayTabBar";
import { dispatchOpenWorkspacePanel } from "@/shared/lib/stella-orb-chat";
import { ShellTopBarWebControls } from "@/shell/ShellTopBarStoreControls";
import { ShellTopBarUpdatePill } from "@/shell/ShellTopBarUpdatePill";

export const STELLA_TOGGLE_SIDEBAR_RAIL_EVENT = "stella:toggle-sidebar-rail";

const MAXIMIZE_STATE_SYNC_DELAY_MS = 50;

const WindowControls = () => {
  const [isMaximized, setIsMaximized] = useState(false);

  const updateMaximizedState = useCallback(() => {
    const promise = window.electronAPI?.window.isMaximized?.();
    if (!promise) return;
    void promise.then((maximized) => setIsMaximized(Boolean(maximized)));
  }, []);

  useEffect(() => {
    updateMaximizedState();
  }, [updateMaximizedState]);

  return (
    <div className="shell-topbar-window-controls">
      <button
        type="button"
        className="shell-topbar-wc-btn"
        onClick={() => window.electronAPI?.window.minimize?.()}
        aria-label="Minimize"
      >
        <Minus size={13} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="shell-topbar-wc-btn"
        onClick={() => {
          window.electronAPI?.window.maximize?.();
          window.setTimeout(updateMaximizedState, MAXIMIZE_STATE_SYNC_DELAY_MS);
        }}
        aria-label={isMaximized ? "Restore" : "Maximize"}
      >
        {isMaximized ? (
          <Square size={11} strokeWidth={1.8} />
        ) : (
          <Maximize2 size={12} strokeWidth={1.8} />
        )}
      </button>
      <button
        type="button"
        className="shell-topbar-wc-btn shell-topbar-wc-close"
        onClick={() => window.electronAPI?.window.close?.()}
        aria-label="Close"
      >
        <X size={13} strokeWidth={1.8} />
      </button>
    </div>
  );
};

export const ShellTopBar = () => {
  const router = useRouter();
  const isMac = getPlatform() === "darwin";
  const isMiniWindow = useWindowType() === "mini";
  const { panelOpen, panelExpanded, panelWidth } = useDisplayPanelLayout();
  // Only the Store route adapts the top bar — other routes keep the
  // default layout (display tab strip on the right).
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isStoreRoute = pathname === "/store" || pathname.startsWith("/store/");
  const isBillingRoute =
    pathname === "/billing" || pathname.startsWith("/billing/");
  const webViewSurfaceLabel = isStoreRoute
    ? "Store"
    : isBillingRoute
      ? "Billing"
      : null;
  const [miniAlwaysOnTop, setMiniAlwaysOnTopState] = useState(true);

  useEffect(() => {
    if (!isMiniWindow) return;
    let cancelled = false;
    void window.electronAPI?.window.isMiniAlwaysOnTop?.().then((enabled) => {
      if (!cancelled) setMiniAlwaysOnTopState(Boolean(enabled));
    });
    return () => {
      cancelled = true;
    };
  }, [isMiniWindow]);

  const toggleMiniAlwaysOnTop = useCallback(() => {
    const next = !miniAlwaysOnTop;
    setMiniAlwaysOnTopState(next);
    void window.electronAPI?.window
      .setMiniAlwaysOnTop?.(next)
      .then((actual) => setMiniAlwaysOnTopState(Boolean(actual)))
      .catch(() => setMiniAlwaysOnTopState(!next));
  }, [miniAlwaysOnTop]);

  const tabsStyle: CSSProperties | undefined =
    panelWidth != null
      ? ({ "--display-panel-width": `${panelWidth}px` } as CSSProperties)
      : undefined;

  return (
    <header
      className="shell-topbar"
      data-platform={isMac ? "mac" : "other"}
      data-display-open={panelOpen ? "true" : "false"}
      data-display-expanded={panelExpanded ? "true" : "false"}
      data-route={
        isStoreRoute ? "store" : isBillingRoute ? "billing" : undefined
      }
    >
      <div className="shell-topbar-left">
        <button
          type="button"
          className="shell-topbar-icon-btn shell-topbar-history-btn"
          onClick={() => router.history.back()}
          aria-label="Back"
          title="Back"
        >
          <ArrowLeft size={15} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="shell-topbar-icon-btn shell-topbar-history-btn"
          onClick={() => router.history.forward()}
          aria-label="Forward"
          title="Forward"
        >
          <ArrowRight size={15} strokeWidth={1.75} />
        </button>
        <ShellTopBarUpdatePill />
      </div>
      {/*
       * Centered route-specific nav: rendered as an absolutely-positioned
       * overlay so neither the left nor right cluster shifts when it
       * appears/disappears. Today only Store uses it; other routes can
       * mount their own component the same way later.
       */}
      {webViewSurfaceLabel ? (
        <div className="shell-topbar-center">
          <ShellTopBarWebControls surfaceLabel={webViewSurfaceLabel} />
        </div>
      ) : null}
      <div className="shell-topbar-tabs" style={tabsStyle}>
        <DisplayTabBar />
      </div>
      <div className="shell-topbar-right">
        {isMiniWindow ? (
          <button
            type="button"
            className="shell-topbar-icon-btn"
            onClick={toggleMiniAlwaysOnTop}
            aria-label={
              miniAlwaysOnTop
                ? "Disable always on top"
                : "Keep mini window on top"
            }
            aria-pressed={miniAlwaysOnTop}
            title={
              miniAlwaysOnTop
                ? "Disable always on top"
                : "Keep mini window on top"
            }
          >
            <Pin size={14} strokeWidth={1.75} />
          </button>
        ) : null}
        <div className="shell-topbar-display-controls">
          {panelOpen ? (
            <>
              <button
                type="button"
                className="shell-topbar-icon-btn"
                onClick={() => displayTabs.togglePanelExpanded()}
                aria-label={
                  panelExpanded ? "Restore panel size" : "Expand panel"
                }
                aria-pressed={panelExpanded}
                title={panelExpanded ? "Restore panel size" : "Expand panel"}
              >
                {panelExpanded ? (
                  <Minimize2 size={14} strokeWidth={1.75} />
                ) : (
                  <Maximize2 size={14} strokeWidth={1.75} />
                )}
              </button>
              <button
                type="button"
                className="shell-topbar-icon-btn"
                onClick={() => displayTabs.setPanelOpen(false)}
                aria-label="Close workspace panel"
                title="Close workspace panel"
              >
                <X size={16} strokeWidth={1.85} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="shell-topbar-icon-btn"
              onClick={dispatchOpenWorkspacePanel}
              aria-label="Open workspace panel"
              title="Open workspace panel"
            >
              <PanelRight size={14} strokeWidth={1.75} />
            </button>
          )}
        </div>
        {!isMac && isMiniWindow ? <WindowControls /> : null}
      </div>
    </header>
  );
};
