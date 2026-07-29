/**
 * The right sidebar's tab rail: Files and Apps.
 *
 * Clicking the active tab returns a drilled-in section to its default view;
 * clicking it while already at that view does nothing.
 *
 * Activity lives outside the sidebar as a standalone surface.
 */

import {
  resolvePanelSidebarSection,
  sidebarSections,
  useActiveSidebarSection,
  type SidebarSection,
} from "@/features/workspace-display/sidebar-sections";
import { displaySearchStore } from "@/features/workspace-display/display-search-store";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import {
  AppWindowMac,
  Folder,
  LayoutList,
  Settings,
  type IconProps,
} from "@/ui/icons";
import type { ComponentType } from "react";
import "./sidebar-tab-rail.css";

const SIDEBAR_TAB_SECTIONS = ["files", "apps"] as const;

export const SIDEBAR_SECTION_META: Record<
  SidebarSection,
  { label: string; Icon: ComponentType<IconProps> }
> = {
  home: { label: "Home", Icon: LayoutList },
  files: { label: "Files", Icon: Folder },
  apps: { label: "Apps", Icon: AppWindowMac },
  settings: { label: "Settings", Icon: Settings },
};

export function SidebarTabRail() {
  const activeSection = useActiveSidebarSection();
  const activePanelSection = resolvePanelSidebarSection(activeSection);
  const panelOpen = useDisplayPanelOpen();

  return (
    <div className="sidebar-tab-rail" role="tablist" aria-label="Sidebar">
      {SIDEBAR_TAB_SECTIONS.map((section) => {
        const { label, Icon } = SIDEBAR_SECTION_META[section];
        const active = panelOpen && section === activePanelSection;
        return (
          <button
            key={section}
            type="button"
            role="tab"
            className="sidebar-tab-rail__tab"
            data-active={active ? "true" : undefined}
            aria-selected={active}
            aria-label={label}
            title={label}
            onClick={() => {
              displaySearchStore.close();
              sidebarSections.selectSection(section);
            }}
          >
            <span className="sidebar-tab-rail__icon" aria-hidden="true">
              <Icon size={15} strokeWidth={1.75} />
            </span>
            <span className="sidebar-tab-rail__label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
