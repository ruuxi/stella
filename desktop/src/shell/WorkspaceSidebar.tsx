/**
 * Persistent floating left sidebar — the consolidated index.
 *
 * Top-to-bottom: primary nav (Home / Store / Social / Search), the
 * user's Apps, and the Activity / Files / Schedule / Store sections
 * (reused from `WorkspacePanelOverview`). Nav and app rows navigate the
 * center content; section items open the right-side viewer (master-detail).
 *
 * Full window only — the mini window keeps its own chrome.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { Search } from "@/ui/icons";
import type { AppMetadata } from "@/app/_shared/app-metadata";
import {
  getSnapshot as getAppRegistrySnapshot,
  subscribe as subscribeToAppRegistry,
} from "@/shell/sidebar/app-registry";
import {
  getSnapshot as getUserAppsSnapshot,
  subscribe as subscribeToUserApps,
  type UserApp,
} from "@/app/_user/user-apps-registry";
import { getPlatform } from "@/platform/electron/platform";
import {
  displaySearchStore,
  useDisplaySearchQuery,
} from "@/features/workspace-display/display-search-store";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import {
  useSectionCollapsed,
  sectionCollapseStore,
} from "./section-collapse-store";
import { WorkspacePanelOverview } from "@/shell/WorkspacePanelOverview";
import { ShellTopBarAccount } from "@/shell/sidebar/ShellTopBarAccount";
import { ShellTopBarUpdatePill } from "@/shell/ShellTopBarUpdatePill";
import { WindowControls } from "@/shell/WindowControls";
import { DisplaySidebarModelsButton } from "@/shell/display/DisplaySidebarModelsButton";
import { CustomLayout } from "@/ui/nav-icons";
import "./workspace-sidebar.css";
import "./shell-junction.css";

const useRegisteredApps = (): readonly AppMetadata[] =>
  useSyncExternalStore(subscribeToAppRegistry, getAppRegistrySnapshot);

const useUserApps = (): readonly UserApp[] =>
  useSyncExternalStore(subscribeToUserApps, getUserAppsSnapshot);

type WorkspaceSidebarProps = {
  onSignIn?: () => void;
  onConnect?: () => void;
  /** When true, the sidebar animates its width to 0 (stays mounted). */
  collapsed?: boolean;
};

export function WorkspaceSidebar({
  onSignIn,
  onConnect,
  collapsed = false,
}: WorkspaceSidebarProps) {
  const query = useDisplaySearchQuery();
  const allApps = useRegisteredApps();
  const userApps = useUserApps();
  const matchRoute = useMatchRoute();
  const appsCollapsed = useSectionCollapsed("apps");
  const panelOpen = useDisplayPanelOpen();
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const showWindowsControlsOnLeft = isWin && !panelOpen;

  // Primary nav: top-slot apps, minus the legacy "apps" launcher entry
  // (the user's apps are listed directly below).
  const navApps = useMemo(
    () =>
      allApps.filter(
        (app) =>
          !app.hideFromSidebar && app.slot === "top" && app.id !== "apps",
      ),
    [allApps],
  );

  const hasApps = userApps.length > 0;

  // Search renders as a compact button until clicked, then becomes the input.
  const [searchActive, setSearchActive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const showSearchInput = searchActive || query.length > 0;
  useEffect(() => {
    if (searchActive) searchInputRef.current?.focus();
  }, [searchActive]);

  return (
    <aside
      className={`workspace-sidebar${collapsed ? " workspace-sidebar--collapsed" : ""}`}
      data-platform={isMac ? "mac" : isWin ? "win" : "other"}
      aria-label="Sidebar"
      aria-hidden={collapsed || undefined}
    >
      <div className="workspace-sidebar__frame">
        <div className="workspace-sidebar__chrome">
          <ShellTopBarUpdatePill />
          <div
            className="workspace-sidebar__chrome-spacer"
            aria-hidden="true"
          />
          {showWindowsControlsOnLeft ? (
            <WindowControls useWindowsIcons hidden={false} />
          ) : null}
        </div>
        <div className="workspace-sidebar__scroll">
          {navApps.length > 0 ? (
            <nav className="workspace-sidebar__nav" aria-label="Navigation">
              {navApps.map((app) => {
                const active = Boolean(
                  matchRoute({ to: app.route, fuzzy: true }),
                );
                const Icon = app.icon;
                return (
                  <Link
                    key={app.id}
                    to={app.route}
                    className="workspace-sidebar__nav-row"
                    data-active={active ? "true" : undefined}
                    aria-current={active ? "page" : undefined}
                    onClick={(event) => {
                      // Re-entry behavior: clicking the already-active nav
                      // entry (e.g. Home while on /chat) runs its
                      // `onActiveClick` (e.g. return to home content)
                      // instead of a no-op navigation.
                      if (active && app.onActiveClick) {
                        event.preventDefault();
                        app.onActiveClick();
                      }
                    }}
                  >
                    <span
                      className="workspace-sidebar__nav-icon"
                      aria-hidden="true"
                    >
                      <Icon size={16} />
                    </span>
                    <span className="workspace-sidebar__nav-label">
                      {app.label}
                    </span>
                  </Link>
                );
              })}

              {showSearchInput ? (
                <div className="workspace-sidebar__nav-row workspace-sidebar__search-row">
                  <span
                    className="workspace-sidebar__nav-icon"
                    aria-hidden="true"
                  >
                    <Search size={16} strokeWidth={1.75} />
                  </span>
                  <input
                    ref={searchInputRef}
                    type="text"
                    className="workspace-sidebar__search-input"
                    value={query}
                    placeholder="Search"
                    onChange={(event) =>
                      displaySearchStore.setQuery(event.currentTarget.value)
                    }
                    onBlur={() => {
                      if (query.length === 0) setSearchActive(false);
                    }}
                    aria-label="Search activity, files, and more"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="workspace-sidebar__nav-row workspace-sidebar__search-row"
                  onClick={() => setSearchActive(true)}
                >
                  <span
                    className="workspace-sidebar__nav-icon"
                    aria-hidden="true"
                  >
                    <Search size={16} strokeWidth={1.75} />
                  </span>
                  <span className="workspace-sidebar__nav-label">Search</span>
                </button>
              )}
            </nav>
          ) : null}

          {hasApps ? (
            <section className="workspace-sidebar__section">
              <button
                type="button"
                className="workspace-sidebar__section-header"
                onClick={() => sectionCollapseStore.toggle("apps")}
                aria-expanded={!appsCollapsed}
              >
                Apps
              </button>
              <div
                className="workspace-sidebar__section-collapse"
                data-collapsed={appsCollapsed ? "true" : undefined}
              >
                <ul className="workspace-sidebar__app-list">
                  {userApps.map((app) => {
                    const active = Boolean(
                      matchRoute({
                        to: "/apps/$slug",
                        params: { slug: app.slug },
                      }),
                    );
                    return (
                      <li key={app.slug}>
                        <Link
                          to="/apps/$slug"
                          params={{ slug: app.slug }}
                          className="workspace-sidebar__nav-row"
                          data-active={active ? "true" : undefined}
                        >
                          <span
                            className="workspace-sidebar__nav-icon"
                            aria-hidden="true"
                          >
                            <CustomLayout size={16} />
                          </span>
                          <span className="workspace-sidebar__nav-label">
                            {app.meta.label}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          ) : null}

          <WorkspacePanelOverview query={query} variant="overview" />
        </div>

        <div className="workspace-sidebar__footer">
          <DisplaySidebarModelsButton />
          <ShellTopBarAccount onSignIn={onSignIn} onConnect={onConnect} />
        </div>
      </div>
    </aside>
  );
}
