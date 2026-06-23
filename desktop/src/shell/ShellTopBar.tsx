import { useCallback, useEffect, useState } from "react";
import { Pin } from "@/ui/icons";
import { getPlatform } from "@/platform/electron/platform";
import { useWindowType } from "@/shared/hooks/use-window-type";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import { DisplayPanelControls } from "@/shell/DisplayPanelControls";
import { WindowControls } from "@/shell/WindowControls";

type ShellTopBarProps = Record<string, never>;

export const ShellTopBar = ({}: ShellTopBarProps) => {
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const isMiniWindow = useWindowType() === "mini";
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
      <div className="shell-topbar-spacer" aria-hidden="true" />
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
