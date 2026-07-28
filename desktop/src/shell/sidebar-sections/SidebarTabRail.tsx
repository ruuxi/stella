/**
 * The right sidebar's primary tab rail: Home, Files, Apps.
 *
 * Clicking the active tab returns a drilled-in section to its default view;
 * clicking it while already at that view does nothing.
 */

import {
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

const PRIMARY_SIDEBAR_SECTIONS = ["home", "files", "apps"] as const;

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
  const panelOpen = useDisplayPanelOpen();

  return (
    <div className="sidebar-tab-rail" role="tablist" aria-label="Sidebar">
      {PRIMARY_SIDEBAR_SECTIONS.map((section) => {
        const { label, Icon } = SIDEBAR_SECTION_META[section];
        const active = panelOpen && section === activeSection;
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
