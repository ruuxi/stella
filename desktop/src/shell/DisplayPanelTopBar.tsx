import {
  displayTabs,
  useDisplayPanelExpanded,
  useDisplayPanelOpen,
} from "@/features/workspace-display/tab-store";
import { displaySearchStore } from "@/features/workspace-display/display-search-store";
import { getPlatform } from "@/platform/electron/platform";
import { SidebarTabRail } from "@/shell/sidebar-sections/SidebarTabRail";
import {
  sidebarSections,
  useActiveSidebarSection,
} from "@/features/workspace-display/sidebar-sections";
import { usePostOnboardingHint } from "@/global/onboarding/post-onboarding-hints";
import { WindowControls } from "@/shell/WindowControls";
import { PanelRight, Settings } from "@/ui/icons";

export function DisplayPanelTopBar() {
  const panelOpen = useDisplayPanelOpen();
  const panelExpanded = useDisplayPanelExpanded();
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const activeSection = useActiveSidebarSection();
  const connectHint = usePostOnboardingHint("connect");

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
        className="shell-topbar-account-settings"
        data-active={
          panelOpen && activeSection === "settings" ? "true" : undefined
        }
        onClick={() => {
          displaySearchStore.close();
          sidebarSections.openLocation("settings", null);
        }}
        aria-label="Settings"
        aria-pressed={panelOpen && activeSection === "settings"}
        title="Settings"
      >
        <Settings size={14} strokeWidth={1.75} />
        {connectHint.active ? (
          <span className="shell-topbar-nav-hint-dot" aria-hidden="true" />
        ) : null}
      </button>
      <button
        type="button"
        className="shell-topbar-icon-btn"
        onClick={() => {
          if (panelOpen) displaySearchStore.close();
          displayTabs.setPanelOpen(!panelOpen);
        }}
        aria-label={panelOpen ? "Close panel" : "Open panel"}
        aria-expanded={panelOpen}
        title={panelOpen ? "Close panel" : "Open panel"}
      >
        <PanelRight size={16} strokeWidth={1.75} />
      </button>
      {isWin ? <WindowControls useWindowsIcons hidden={false} /> : null}
    </header>
  );
}
