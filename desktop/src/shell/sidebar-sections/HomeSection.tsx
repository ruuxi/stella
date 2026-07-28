/**
 * Home — the agent activity index.
 *
 * Sub-location (`sidebarSections` → `locations.home`) is the display-tab id of
 * an agent-thread drill-down, or `null` for the thread list. Search lives in
 * the radial overlay, keeping this section focused on the activity overview.
 */

import {
  sidebarSections,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayTabList } from "@/features/workspace-display/tab-store";
import { WorkspaceSections } from "@/shell/workspace/WorkspaceSections";
import { ChevronLeft } from "@/ui/icons";
import { DeferredDisplayContent } from "./DeferredDisplayContent";
import "./home-search.css";

function HomeOverview() {
  return (
    <div className="sidebar-search">
      <div className="sidebar-search__body">
        <WorkspaceSections
          variant="overview"
          renderEmpty={() => (
            <div className="sidebar-section__empty">
              Activity will show up here as Stella works.
            </div>
          )}
        />
      </div>
    </div>
  );
}

export function HomeSection() {
  const openTabId = useSidebarSectionLocation("home");
  const { tabs } = useDisplayTabList();

  // A remembered id can outlive its tab (the registry is not persisted across
  // launches). Falling back to the list is the graceful degradation.
  const openTab = openTabId
    ? (tabs.find((tab) => tab.id === openTabId) ?? null)
    : null;

  if (!openTab) {
    return <HomeOverview />;
  }

  return (
    <>
      <div className="sidebar-section__viewer-head">
        <button
          type="button"
          className="sidebar-section__back"
          onClick={() => sidebarSections.clearLocation("home")}
          aria-label="Back to home"
        >
          <ChevronLeft size={15} strokeWidth={1.75} aria-hidden="true" />
          Home
        </button>
        <span className="sidebar-section__viewer-title">{openTab.title}</span>
      </div>
      <div className="sidebar-section__viewer-body">
        <DeferredDisplayContent key={openTab.id} render={openTab.render} />
      </div>
    </>
  );
}
