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

  return (
    <header
      className="display-panel-topbar"
      data-platform={isMac ? "mac" : isWin ? "win" : "other"}
      data-display-open={panelOpen ? "true" : "false"}
      data-display-expanded={panelExpanded ? "true" : "false"}
      aria-hidden={!panelOpen}
      inert={!panelOpen}
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
