/**
 * Search — the activity-tray search, relocated into its own tab.
 *
 * Has no sub-location: the query itself lives in `display-search-store` so the
 * composer pill and this tab share one query.
 */

export function SearchSection() {
  return (
    <div className="sidebar-section__empty">
      Search activity, files, and more.
    </div>
  );
}
