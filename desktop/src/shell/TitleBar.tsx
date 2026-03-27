import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "@/context/workspace-state";
import { getPlatform } from "@/platform/electron/platform";
import { NotificationPanel } from "@/shell/notifications/NotificationPanel";
import { useActivityData } from "@/shell/notifications/use-activity-data";

const MAXIMIZE_STATE_SYNC_DELAY_MS = 50;

type TitleBarProps = {
  conversationId?: string;
  appReady?: boolean;
};

export const TitleBar = ({ conversationId, appReady }: TitleBarProps) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { state: workspaceState } = useWorkspace();
  const isMac = getPlatform() === "darwin";
  const panelTitle = workspaceState.activePanel?.title ?? workspaceState.activePanel?.name;
  const activityData = useActivityData(appReady ? conversationId : undefined);

  const updateMaximizedState = useCallback(() => {
    const promise = window.electronAPI?.window.isMaximized?.();
    if (!promise) {
      return;
    }

    void promise.then((maximized) => {
      setIsMaximized(Boolean(maximized));
    });
  }, []);

  useEffect(() => {
    updateMaximizedState();
  }, [updateMaximizedState]);

  const handleMinimize = () => {
    window.electronAPI?.window.minimize?.();
  };

  const handleMaximize = () => {
    window.electronAPI?.window.maximize?.();
    window.setTimeout(updateMaximizedState, MAXIMIZE_STATE_SYNC_DELAY_MS);
  };

  const handleClose = () => {
    window.electronAPI?.window.close?.();
  };

  useEffect(() => {
    if (!isNotifOpen) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (bellRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setIsNotifOpen(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsNotifOpen(false);
    };

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isNotifOpen]);

  const handleNotifClick = useCallback(() => {
    setIsNotifOpen((prev) => !prev);
  }, []);

  const bellButton = appReady ? (
    <button
      ref={bellRef}
      className={`title-bar-notif-bell${isNotifOpen ? " title-bar-notif-bell--active" : ""}`}
      onClick={handleNotifClick}
      aria-label="Notifications"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 13a2 2 0 0 0 4 0" />
        <path d="M12 6c0-2.2-1.8-4-4-4S4 3.8 4 6c0 3.1-1.3 4.5-2 5h12c-.7-.5-2-1.9-2-5Z" />
      </svg>
    </button>
  ) : null;

  const notifPanel = appReady
    ? createPortal(
        <div ref={panelRef}>
          <NotificationPanel
            open={isNotifOpen}
            data={activityData}
            style={{
              top: "36px",
              right: isMac ? "12px" : "150px",
            }}
          />
        </div>,
        document.body,
      )
    : null;

  const titleLabel = panelTitle ? (
    <span className="title-bar-workspace-label">{panelTitle}</span>
  ) : null;

  if (isMac) {
    return (
      <div className="title-bar title-bar-mac" data-app-ready={appReady || undefined}>
        <div className="title-bar-drag-region" />
        {titleLabel}
        {bellButton}
        {notifPanel}
      </div>
    );
  }

  return (
    <div className="title-bar" data-app-ready={appReady || undefined}>
      <div className="title-bar-drag-region" />
      {titleLabel}
      <div className="title-bar-controls">
        {bellButton}
        <button
          className="title-bar-button"
          onClick={handleMinimize}
          aria-label="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 1">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="title-bar-button"
          onClick={handleMaximize}
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                d="M2.5 0.5h7v7h-7zM0.5 2.5v7h7"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect
                x="0.5"
                y="0.5"
                width="9"
                height="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          )}
        </button>
        <button
          className="title-bar-button title-bar-close"
          onClick={handleClose}
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              stroke="currentColor"
              strokeWidth="1.2"
              d="M1 1l8 8M9 1l-8 8"
            />
          </svg>
        </button>
      </div>
      {notifPanel}
    </div>
  );
};
