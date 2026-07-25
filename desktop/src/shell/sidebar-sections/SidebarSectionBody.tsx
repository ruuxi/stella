/**
 * Renders whichever of the four sections is active.
 *
 * Every section is mounted for the lifetime of the panel and hidden with
 * `display: none` rather than unmounted. That is load-bearing, not an
 * optimization: the Files section hosts canvas iframes whose browsing context
 * is destroyed by an unmount, and the Apps section hosts live user apps whose
 * whole point is that they keep running. Switching tabs must not cost either
 * of them their state, and neither must closing the panel — which is why the
 * hidden host stays mounted even when `panelOpen` is false.
 */

import { SIDEBAR_SECTIONS } from "@/features/workspace-display/sidebar-sections";
import { useActiveSidebarSection } from "@/features/workspace-display/sidebar-sections";
import { AppsSection } from "./AppsSection";
import { FilesSection } from "./FilesSection";
import { SearchSection } from "./SearchSection";
import { TasksSection } from "./TasksSection";
import "./sidebar-sections.css";

const SECTION_BODIES = {
  tasks: TasksSection,
  files: FilesSection,
  search: SearchSection,
  apps: AppsSection,
} as const;

export function SidebarSectionBody() {
  const activeSection = useActiveSidebarSection();

  return (
    <>
      {SIDEBAR_SECTIONS.map((section) => {
        const Body = SECTION_BODIES[section];
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
