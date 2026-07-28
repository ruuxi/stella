import {
  useDisplayPanelExpanded,
  useDisplayPanelOpen,
} from "@/features/workspace-display/tab-store";
import { getPlatform } from "@/platform/electron/platform";
import { DisplayPanelControls } from "@/shell/DisplayPanelControls";
import { SidebarTabRail } from "@/shell/sidebar-sections/SidebarTabRail";
import {
  sidebarSections,
  useActiveSidebarSection,
} from "@/features/workspace-display/sidebar-sections";
import { WindowControls } from "@/shell/WindowControls";
import { Settings } from "@/ui/icons";

export function DisplayPanelTopBar() {
  const panelOpen = useDisplayPanelOpen();
  const panelExpanded = useDisplayPanelExpanded();
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const activeSection = useActiveSidebarSection();

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
      <button
        type="button"
        className="shell-topbar-icon-btn"
        data-active={activeSection === "settings" ? "true" : undefined}
        onClick={() => sidebarSections.openLocation("settings", null)}
        aria-label="Settings"
        aria-pressed={activeSection === "settings"}
        title="Settings"
      >
        <Settings size={16} strokeWidth={1.75} />
      </button>
      <DisplayPanelControls />
      {isWin && panelExpanded ? (
        <WindowControls useWindowsIcons hidden={false} />
      ) : null}
    </header>
  );
}
