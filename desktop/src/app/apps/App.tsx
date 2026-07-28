/**
 * The full-page user-app library.
 *
 * Apps themselves open in the right sidebar's Apps section, which also carries
 * its own library list. This route remains available to deep links, but picking
 * an app here still hands off to the sidebar rather than rendering it inline,
 * so there is exactly one place a user app is ever mounted.
 */

import {
  useDeferredValue,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Search } from "@/ui/icons";
import { Select } from "@/ui/select";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import {
  getSnapshot,
  subscribe,
  type UserApp,
} from "@/app/_user/user-apps-registry";
import { AppCreationIllustration } from "./AppCreationIllustration";
import {
  formatUserAppCreatedAt,
  listUserApps,
  USER_APP_SORT_LABELS,
  useRequestUserApp,
  type UserAppSort,
} from "./user-app-library";
import "./apps.css";

function useUserApps(): readonly UserApp[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function AppsApp() {
  const apps = useUserApps();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<UserAppSort>("recent");
  const deferredQuery = useDeferredValue(query);
  const handleCreateApp = useRequestUserApp();

  const visible = useMemo(
    () => listUserApps(apps, deferredQuery, sort),
    [apps, deferredQuery, sort],
  );

  const hasApps = apps.length > 0;

  return (
    <main className="apps-screen">
      {hasApps ? (
        <header className="apps-screen__hero">
          <h1 className="apps-screen__title">
            <em>Your</em> apps
          </h1>
        </header>
      ) : null}

      {hasApps ? (
        <>
          <div className="apps-screen__toolbar">
            <label className="apps-screen__search">
              <Search
                size={14}
                className="apps-screen__search-icon"
                aria-hidden
              />
              <input
                type="search"
                placeholder="Search apps"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                className="apps-screen__search-input"
              />
            </label>
            <div className="apps-screen__sort">
              <span className="apps-screen__sort-label">Sort</span>
              <Select<UserAppSort>
                className="apps-screen__sort-trigger"
                value={sort}
                onValueChange={setSort}
                options={(
                  Object.keys(USER_APP_SORT_LABELS) as UserAppSort[]
                ).map((option) => ({
                  value: option,
                  label: USER_APP_SORT_LABELS[option],
                }))}
                aria-label="Sort"
              />
            </div>
            <button
              type="button"
              className="pill-btn pill-btn--lg"
              onClick={handleCreateApp}
            >
              Create an app
            </button>
          </div>

          {visible.length === 0 ? (
            <div className="apps-screen__no-match">
              No apps match <span className="apps-screen__no-match-query">"{deferredQuery}"</span>.
            </div>
          ) : (
            <ul className="apps-screen__grid">
              {visible.map((app) => (
                <li key={app.slug} className="apps-card">
                  <button
                    type="button"
                    className="apps-card__link"
                    onClick={() => sidebarSections.openLocation("apps", app.slug)}
                  >
                    <span className="apps-card__label">{app.meta.label}</span>
                    <span className="apps-card__meta">
                      {formatUserAppCreatedAt(app.meta.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <section className="apps-screen__empty" aria-labelledby="apps-empty-title">
          <div className="apps-screen__empty-illustration">
            <AppCreationIllustration />
          </div>
          <h2 id="apps-empty-title" className="apps-screen__empty-title">
            Nothing here yet.
          </h2>
          <p className="apps-screen__empty-body">
            Ask Stella to build a small app. It will show up here.
          </p>
          <button
            type="button"
            className="pill-btn pill-btn--primary pill-btn--lg"
            onClick={handleCreateApp}
          >
            Ask Stella to create an app
          </button>
        </section>
      )}
    </main>
  );
}
