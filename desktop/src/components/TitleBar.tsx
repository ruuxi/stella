import { useState, useEffect } from 'react';
import { ThemePicker } from './ThemePicker';
import { AuthStatus } from './AuthStatus';

interface TitleBarProps {
  hideThemePicker?: boolean;
  themePickerOpen?: boolean;
  onThemePickerOpenChange?: (open: boolean) => void;
  onThemeSelect?: () => void;
}

export const TitleBar = ({ 
  hideThemePicker = false,
  themePickerOpen,
  onThemePickerOpenChange,
  onThemeSelect,
}: TitleBarProps) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const platform = window.electronAPI?.platform ?? 'unknown';
  const isMac = platform === 'darwin';

  useEffect(() => {
    // Check initial maximized state
    window.electronAPI?.isMaximized?.().then(setIsMaximized);
  }, []);

  const handleMinimize = () => {
    window.electronAPI?.minimizeWindow?.();
  };

  const handleMaximize = async () => {
    window.electronAPI?.maximizeWindow?.();
    // Update state after a short delay
    setTimeout(async () => {
      const maximized = await window.electronAPI?.isMaximized?.();
      setIsMaximized(maximized ?? false);
    }, 50);
  };

  const handleClose = () => {
    window.electronAPI?.closeWindow?.();
  };

  // On macOS, we use native traffic lights, so only show drag region
  if (isMac) {
    return (
      <div className="title-bar title-bar-mac">
        <div className="title-bar-drag-region" />
        <div className="title-bar-left">
          <AuthStatus />
          <ThemePicker 
            hideTrigger={hideThemePicker} 
            open={themePickerOpen}
            onOpenChange={onThemePickerOpenChange}
            onThemeSelect={onThemeSelect}
          />
        </div>
      </div>
    );
  }

  // Windows/Linux: Show custom window controls
  return (
    <div className="title-bar">
      <div className="title-bar-drag-region" />
      <div className="title-bar-left">
        <ThemePicker 
          hideTrigger={hideThemePicker}
          open={themePickerOpen}
          onOpenChange={onThemePickerOpenChange}
          onThemeSelect={onThemeSelect}
        />
        <AuthStatus />
      </div>
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
