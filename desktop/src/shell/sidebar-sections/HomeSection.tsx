/**
 * Home — the agent activity index, with search folded in as a control.
 *
 * Sub-location (`sidebarSections` → `locations.home`) is the display-tab id of
 * an agent-thread drill-down, or `null` for the thread list.
 *
 * The search field at the top of the list view is the old Search section,
 * demoted from a tab of its own: it filters the same workspace overview this
 * section renders, and its query lives in `display-search-store` so the
 * composer pill and this view share one query. With an empty query the list
 * is the plain unfiltered activity overview.
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

/**
 * Whether the results region should hold its fixed "searching" layout (a
 * resolved, scroll-bounded box) rather than its natural content-fit height.
 *
 * Two inputs, deliberately OR'd:
 *   • `inputValue` — the immediate keystroke value, so the fixed box engages
 *     on the very first character, before the debounced/deferred results
 *     reconcile (no first-keystroke jump).
 *   • `deferredQuery` — the value the results are actually rendered from.
 *     Holding on it keeps the fixed layout in place after the field is
 *     cleared until the results reconcile back to the overview, so clearing
 *     collapses the box exactly once (a single settle) instead of dropping
 *     the layout immediately and resizing again 150ms later when the query
 *     clears (the two-stage drop).
 */
export const shouldHoldSearchLayout = (
  inputValue: string,
  deferredQuery: string,
): boolean => inputValue.trim().length > 0 || deferredQuery.trim().length > 0;

/**
 * The activity list with its search field. Unlike the old Search tab, the
 * field never auto-focuses: Home is the default section, and stealing the
 * caret from the composer on every panel open would be hostile.
 */
function HomeOverview() {
  const query = useDisplaySearchQuery();
  const [inputValue, setInputValue] = useState(query);
  const deferredQuery = useDeferredValue(query);

  // Keep typing on the input's tiny local state and only wake the full
  // activity/files search tree after a short pause. `useDeferredValue` gives
  // React room to paint the final keystroke before reconciling the results.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      displaySearchStore.setQuery(inputValue);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [inputValue]);

  // While searching, the body becomes a resolved-height, internally-scrolling
  // box (see CSS) so the section's layout stays put no matter how many results
  // match — the results scroll inside a stable frame instead of re-flowing per
  // keystroke.
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
