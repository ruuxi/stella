/**
 * Search — one query field over the same workspace overview Tasks renders,
 * filtered. Files and Store only ever list here, as search results.
 *
 * Has no sub-location: the query itself lives in `display-search-store` so the
 * composer pill and this tab share one query.
 */

import { useDeferredValue, useEffect, useRef, useState } from "react";
import {
  displaySearchStore,
  useDisplaySearchQuery,
} from "@/features/workspace-display/display-search-store";
import { useActiveSidebarSection } from "@/features/workspace-display/sidebar-sections";
import { WorkspaceSections } from "@/shell/workspace/WorkspaceSections";
import { Search } from "@/ui/icons";
import "./search-section.css";

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

export function SearchSection() {
  const active = useActiveSidebarSection() === "search";
  const query = useDisplaySearchQuery();
  const [inputValue, setInputValue] = useState(query);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);

  // Every section stays mounted for the panel's lifetime, so the field takes
  // focus on becoming active rather than on mount — otherwise it would steal
  // the caret once, at startup, while some other tab is on screen.
  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

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
  // keystroke. The layout is held on the immediate input OR the still-deferred
  // query so it engages before the first result and collapses only once, after
  // the field clears and results reconcile.
  const searching = shouldHoldSearchLayout(inputValue, deferredQuery);

  return (
    <div className="sidebar-search" data-searching={searching || undefined}>
      <div className="sidebar-search__field">
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={inputRef}
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
