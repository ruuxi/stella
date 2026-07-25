/**
 * The right sidebar's four-tab rail: Tasks, Files, Search, Apps.
 *
 * Clicking a tab goes through the same `selectSection` verb the radial dial
 * uses, so both entry points share one open/switch/close rule — including the
 * "select the active tab again to close" behavior, which is why these are
 * buttons rather than a radio group.
 */

import {
  SIDEBAR_SECTIONS,
  sidebarSections,
  useActiveSidebarSection,
  type SidebarSection,
} from "@/features/workspace-display/sidebar-sections";
import {
  AppWindowMac,
  Folder,
  LayoutList,
  Search,
  type IconProps,
} from "@/ui/icons";
import type { ComponentType } from "react";
import "./sidebar-tab-rail.css";

export const SIDEBAR_SECTION_META: Record<
  SidebarSection,
  { label: string; Icon: ComponentType<IconProps> }
> = {
  tasks: { label: "Tasks", Icon: LayoutList },
  files: { label: "Files", Icon: Folder },
  search: { label: "Search", Icon: Search },
  apps: { label: "Apps", Icon: AppWindowMac },
};

export function SidebarTabRail() {
  const activeSection = useActiveSidebarSection();

  return (
    <div className="sidebar-tab-rail" role="tablist" aria-label="Sidebar">
      {SIDEBAR_SECTIONS.map((section) => {
        const { label, Icon } = SIDEBAR_SECTION_META[section];
        const active = section === activeSection;
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
            onClick={() => sidebarSections.selectSection(section)}
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
