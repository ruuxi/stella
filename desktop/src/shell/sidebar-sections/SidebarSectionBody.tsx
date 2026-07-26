/**
 * Renders whichever of the three sections is active.
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
import { SIDEBAR_SECTIONS } from "@/features/workspace-display/sidebar-sections";
import {
  resolveSidebarSection,
  useActiveSidebarSection,
  type SidebarSection,
} from "@/features/workspace-display/sidebar-sections";
import { AppsSection } from "./AppsSection";
import { FilesSection } from "./FilesSection";
import { HomeSection } from "./HomeSection";
import "./sidebar-sections.css";

/**
 * Typed as a total `Record` rather than inferred: adding a section without a
 * body is then a compile error here instead of an `undefined` at render.
 */
const SECTION_BODIES: Record<SidebarSection, ComponentType> = {
  home: HomeSection,
  files: FilesSection,
  apps: AppsSection,
};

/**
 * The body for a section id, never `undefined`.
 *
 * Two independent ways this can miss, both ending in the same place. The id
 * itself may be one no longer in the set — a persisted `tasks`/`search` that
 * outran its migration — which `resolveSidebarSection` degrades to `home`.
 * Or the entry may be present but hold `undefined`, which is what a module
 * graph caught mid-swap looks like: the dev server can hand this file its new
 * body while a just-created sibling is still resolving, and the import binding
 * reads as undefined for that render. Neither is worth taking the shell down
 * for — React treats an undefined element type as a render error, and this
 * component is above the panel's boundary, so the failure is the whole window.
 */
export const sidebarSectionBody = (section: string): ComponentType =>
  SECTION_BODIES[resolveSidebarSection(section)] ?? HomeSection;

export function SidebarSectionBody() {
  const activeSection = useActiveSidebarSection();

  return (
    <>
      {SIDEBAR_SECTIONS.map((section) => {
        const Body = sidebarSectionBody(section);
        const active = section === activeSection;
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
