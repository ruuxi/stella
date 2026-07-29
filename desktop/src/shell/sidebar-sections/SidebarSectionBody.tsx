/**
 * Renders whichever panel-owned sidebar section is active.
 *
 * Every section is mounted for the lifetime of the panel and hidden with
 * `display: none` rather than unmounted. That is load-bearing, not an
 * optimization: the Files section hosts canvas iframes whose browsing context
 * is destroyed by an unmount, and the Apps section hosts live user apps whose
 * whole point is that they keep running. Switching tabs must not cost either
 * of them their state, and neither must closing the panel — which is why the
 * hidden host stays mounted even when `panelOpen` is false.
 */

import type { ComponentType } from "react";
import {
  PANEL_SIDEBAR_SECTIONS,
  resolvePanelSidebarSection,
  useActiveSidebarSection,
  type PanelSidebarSection,
} from "@/features/workspace-display/sidebar-sections";
import { AppsSection } from "./AppsSection";
import { FilesSection } from "./FilesSection";
import { SettingsSection } from "./SettingsSection";
import "./sidebar-sections.css";

/**
 * Typed as a total `Record` rather than inferred: adding a section without a
 * body is then a compile error here instead of an `undefined` at render.
 */
const SECTION_BODIES: Record<PanelSidebarSection, ComponentType> = {
  files: FilesSection,
  apps: AppsSection,
  settings: SettingsSection,
};

/**
 * The body for a section id, never `undefined`.
 *
 * A retired/unknown id degrades to Files, the panel's default section. Home is
 * handled by WorkspaceHomeSurface and never enters this map.
 */
export const sidebarSectionBody = (section: string): ComponentType =>
  SECTION_BODIES[section as PanelSidebarSection] ?? FilesSection;

export function SidebarSectionBody() {
  const activeSection = useActiveSidebarSection();
  const activePanelSection = resolvePanelSidebarSection(activeSection);

  return (
    <>
      {PANEL_SIDEBAR_SECTIONS.map((section) => {
        const Body = sidebarSectionBody(section);
        const active = section === activePanelSection;
        return (
          <div
            key={section}
            className="sidebar-section"
            data-section={section}
            data-active={active ? "true" : undefined}
            role="tabpanel"
            aria-hidden={!active}
            inert={!active}
          >
            <Body />
          </div>
        );
      })}
    </>
  );
}
