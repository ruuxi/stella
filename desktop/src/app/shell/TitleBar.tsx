import { useState, useEffect, useCallback } from 'react';
import { useWorkspace } from '@/providers/workspace-state';
import { getPlatform } from '@/lib/platform';

const MAXIMIZE_STATE_SYNC_DELAY_MS = 50;

export const TitleBar = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const { state: workspaceState } = useWorkspace();
  const platform = getPlatform();
  const isMac = platform === 'darwin';
  const activePanel = workspaceState.activePanel;
  const panelTitle = activePanel && activePanel.name !== 'dashboard'
    ? (activePanel.title ?? activePanel.name)
    : null;
  const panelTitleLabel = panelTitle
    ? <span className="title-bar-workspace-label">{panelTitle}</span>
    : null;

  const syncMaximizedState = useCallback(async () => {
    const maximized = await window.electronAPI?.window.isMaximized?.();
    setIsMaximized(maximized ?? false);
  }, []);

  useEffect(() => {
    void syncMaximizedState();
  }, [syncMaximizedState]);

  const handleMinimize = () => {
    window.electronAPI?.window.minimize?.();
  };

  const handleMaximize = async () => {
    window.electronAPI?.window.maximize?.();
    setTimeout(async () => {
      await syncMaximizedState();
    }, MAXIMIZE_STATE_SYNC_DELAY_MS);
  };

  const handleClose = () => {
    window.electronAPI?.window.close?.();
  };

  // On macOS, we use native traffic lights, so only show drag region
  if (isMac) {
    return (
      <div className="title-bar title-bar-mac">
        <div className="title-bar-drag-region" />
        {panelTitleLabel}
      </div>
    );
  }

  // Windows/Linux: Show custom window controls
  return (
    <div className="title-bar">
      <div className="title-bar-drag-region" />
      {panelTitleLabel}
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
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
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

