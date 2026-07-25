/**
 * Tasks — the agent activity index.
 *
 * Sub-location (`sidebarSections` → `locations.tasks`) is the display-tab id of
 * an agent-thread drill-down, or `null` for the thread list.
 *
 * The index renders unfiltered, and deliberately does not subscribe to the
 * query the Search section writes: typing there must not filter the surface
 * the user is watching live work on.
 */

import {
  sidebarSections,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayTabList } from "@/features/workspace-display/tab-store";
import { WorkspaceSections } from "@/shell/workspace/WorkspaceSections";
import { ChevronLeft } from "@/ui/icons";
import { DeferredDisplayContent } from "./DeferredDisplayContent";

export function TasksSection() {
  const openTabId = useSidebarSectionLocation("tasks");
  const { tabs } = useDisplayTabList();

  // A remembered id can outlive its tab (the registry is not persisted across
  // launches). Falling back to the list is the graceful degradation.
  const openTab = openTabId
    ? (tabs.find((tab) => tab.id === openTabId) ?? null)
    : null;

  if (!openTab) {
    return (
      <WorkspaceSections
        variant="overview"
        renderEmpty={() => (
          <div className="sidebar-section__empty">
            Activity will show up here as Stella works.
          </div>
        )}
      />
    );
  }

  return (
    <>
      <div className="sidebar-section__viewer-head">
        <button
          type="button"
          className="sidebar-section__back"
          onClick={() => sidebarSections.clearLocation("tasks")}
          aria-label="Back to tasks"
        >
          <ChevronLeft size={15} strokeWidth={1.75} aria-hidden="true" />
          Tasks
        </button>
        <span className="sidebar-section__viewer-title">{openTab.title}</span>
      </div>
      <div className="sidebar-section__viewer-body">
        <DeferredDisplayContent key={openTab.id} render={openTab.render} />
      </div>
    </>
  );
}
