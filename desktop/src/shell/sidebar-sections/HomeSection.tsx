/**
 * Home — the agent activity index, with search folded in as a control.
 *
 * Sub-location (`sidebarSections` → `locations.home`) is the display-tab id of
 * an agent-thread drill-down, or `null` for the thread list.
 */

import { useDeferredValue, useEffect, useState } from "react";
import {
  displaySearchStore,
  useDisplaySearchQuery,
} from "@/features/workspace-display/display-search-store";
import {
  sidebarSections,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayTabList } from "@/features/workspace-display/tab-store";
import { WorkspaceSections } from "@/shell/workspace/WorkspaceSections";
import { ChevronLeft, Search } from "@/ui/icons";
import { DeferredDisplayContent } from "./DeferredDisplayContent";
import "./home-search.css";

export const shouldHoldSearchLayout = (
  inputValue: string,
  deferredQuery: string,
): boolean => inputValue.trim().length > 0 || deferredQuery.trim().length > 0;

function HomeOverview() {
  const query = useDisplaySearchQuery();
  const [inputValue, setInputValue] = useState(query);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      displaySearchStore.setQuery(inputValue);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [inputValue]);

  const searching = shouldHoldSearchLayout(inputValue, deferredQuery);

  return (
    <div className="sidebar-search" data-searching={searching || undefined}>
      <div className="sidebar-search__field">
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <input
          type="text"
          className="sidebar-search__input"
          value={inputValue}
          placeholder="Search activity, files, and more"
          onChange={(event) => setInputValue(event.currentTarget.value)}
          aria-label="Search activity, files, and more"
        />
      </div>
      <div className="sidebar-search__body">
        <WorkspaceSections
          query={deferredQuery}
          variant="overview"
          includeUserApps
          renderEmpty={() => (
            <div className="sidebar-section__empty">
              {deferredQuery.trim()
                ? "Nothing matches that search."
                : "Activity will show up here as Stella works."}
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
