import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/context/workspace-state";
import { getPlatform } from "@/platform/electron/platform";

const MAXIMIZE_STATE_SYNC_DELAY_MS = 50;

export const TitleBar = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const { state: workspaceState } = useWorkspace();
  const isMac = getPlatform() === "darwin";
  const panelTitle = workspaceState.activePanel?.title ?? workspaceState.activePanel?.name;

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

  const titleLabel = panelTitle ? (
    <span className="title-bar-workspace-label">{panelTitle}</span>
  ) : null;

  if (isMac) {
    return (
      <div className="title-bar title-bar-mac">
        <div className="title-bar-drag-region" />
        {titleLabel}
      </div>
    );
  }

  return (
    <div className="title-bar">
      <div className="title-bar-drag-region" />
      {titleLabel}
      <div className="title-bar-controls">
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
    </div>
  );
};
