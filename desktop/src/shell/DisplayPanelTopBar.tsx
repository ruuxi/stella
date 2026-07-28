import {
  useDisplayPanelExpanded,
  useDisplayPanelOpen,
} from "@/features/workspace-display/tab-store";
import { getPlatform } from "@/platform/electron/platform";
import { DisplayPanelControls } from "@/shell/DisplayPanelControls";
import { SidebarTabRail } from "@/shell/sidebar-sections/SidebarTabRail";
import { WindowControls } from "@/shell/WindowControls";

export function DisplayPanelTopBar() {
  const panelOpen = useDisplayPanelOpen();
  const panelExpanded = useDisplayPanelExpanded();
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";

  if (!panelOpen) return null;

  return (
    <header
      className="display-panel-topbar"
      data-platform={isMac ? "mac" : isWin ? "win" : "other"}
      data-display-expanded={panelExpanded ? "true" : "false"}
    >
      <div className="display-panel-topbar__tabs">
        <SidebarTabRail />
      </div>
      <DisplayPanelControls />
      {isWin && panelExpanded ? (
        <WindowControls useWindowsIcons hidden={false} />
      ) : null}
    </header>
  );
}
