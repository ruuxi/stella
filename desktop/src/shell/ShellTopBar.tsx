import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Maximize2,
  Minimize2,
  Minus,
  PanelRight,
  Palette,
  Pin,
  Settings,
  Square,
  X,
} from "lucide-react";
import { ThemePicker } from "@/global/settings/ThemePicker";
import { getPlatform } from "@/platform/electron/platform";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { displayTabs, useDisplayTabs } from "@/shell/display/tab-store";
import { dispatchOpenWorkspacePanel } from "@/shared/lib/stella-orb-chat";

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

const SidebarToggleIcon = () => (
  <svg
    aria-hidden="true"
    className="shell-topbar-sidebar-toggle-icon"
    width="15"
    height="15"
    viewBox="0 0 16 16"
    fill="none"
  >
    <rect
      x="2.25"
      y="2.25"
      width="11.5"
      height="11.5"
      rx="2.25"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path
      d="M6.25 2.75V13.25"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

export const ShellTopBar = () => {
  const navigate = useNavigate();
  const router = useRouter();
  const isMac = getPlatform() === "darwin";
  const isMiniWindow = useWindowType() === "mini";
  const { panelOpen, panelExpanded } = useDisplayTabs();
  const [miniAlwaysOnTop, setMiniAlwaysOnTopState] = useState(true);

  const toggleSidebar = useCallback(() => {
    window.dispatchEvent(new Event(STELLA_TOGGLE_SIDEBAR_RAIL_EVENT));
  }, []);

  const openSettings = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);

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

  return (
    <header className="shell-topbar" data-platform={isMac ? "mac" : "other"}>
      <div className="shell-topbar-left">
        <button
          type="button"
          className="shell-topbar-icon-btn"
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
        >
          <SidebarToggleIcon />
        </button>
        <button
          type="button"
          className="shell-topbar-icon-btn"
          onClick={openSettings}
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={14} strokeWidth={1.75} />
        </button>
        <ThemePicker
          side="bottom"
          align="start"
          trigger={
            <button
              type="button"
              className="shell-topbar-icon-btn"
              aria-label="Theme"
              title="Theme"
            >
              <Palette size={14} strokeWidth={1.75} />
            </button>
          }
        />
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
        {!isMac ? <WindowControls /> : null}
      </div>
    </header>
  );
};
