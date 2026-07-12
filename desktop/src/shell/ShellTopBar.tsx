import { useCallback, useEffect, useState } from "react";
import { Pin } from "@/ui/icons";
import { getPlatform } from "@/platform/electron/platform";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import { DisplayPanelControls } from "@/shell/DisplayPanelControls";
import { DisplayTabSwitcher } from "@/shell/display/DisplayTabSwitcher";
import { CanvasTopBarTabs } from "@/shell/display/canvas-tab/CanvasTopBarTabs";
import { ShellTopBarPrimaryNav } from "@/shell/sidebar/ShellTopBarNav";
import { WindowControls } from "@/shell/WindowControls";

export const ShellTopBar = () => {
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const isMiniWindow = useWindowType() === "mini";
  // The mobile WebView shim tags <html> before the app boots, so this is
  // stable for the lifetime of the page. Mini window never has the tag.
  const isMobileWebView =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-platform") === "mobile";
  const panelOpen = useDisplayPanelOpen();
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

  const renderWindowControls = isWin || (!isMac && isMiniWindow);

  const toggleMiniAlwaysOnTop = useCallback(() => {
    const next = !miniAlwaysOnTop;
    setMiniAlwaysOnTopState(next);
    void window.electronAPI?.window
      .setMiniAlwaysOnTop?.(next)
      .then((actual) => setMiniAlwaysOnTopState(Boolean(actual)))
      .catch(() => setMiniAlwaysOnTopState(!next));
  }, [miniAlwaysOnTop]);

  return (
    <header
      className="shell-topbar"
      data-platform={isMac ? "mac" : isWin ? "win" : "other"}
      data-display-open={panelOpen ? "true" : "false"}
    >
      <div className="shell-topbar-left" />
      {panelOpen ? (
        <div className="shell-topbar-tabs">
          <DisplayTabSwitcher />
          <CanvasTopBarTabs />
        </div>
      ) : isMobileWebView ? (
        <ShellTopBarPrimaryNav />
      ) : (
        <div className="shell-topbar-spacer" aria-hidden="true" />
      )}
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
        {panelOpen ? <DisplayPanelControls /> : null}
        {renderWindowControls ? (
          <WindowControls useWindowsIcons={isWin} hidden={panelOpen} />
        ) : null}
      </div>
    </header>
  );
};
