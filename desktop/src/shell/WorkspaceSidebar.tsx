/**
 * Persistent floating left sidebar — the consolidated index.
 *
 * Top-to-bottom: a search box, primary nav (Home / Store / Social), the
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
import { EngineTabContent } from "@/shell/display/EngineTabContent";
import { useEngineOverlayOpen } from "@/shell/display/engine-overlay-store";
import { CustomLayout } from "@/ui/nav-icons";
import "./workspace-sidebar.css";
import "./shell-junction.css";

const ENGINE_FADE_MS = 180;

const useRegisteredApps = (): readonly AppMetadata[] =>
  useSyncExternalStore(subscribeToAppRegistry, getAppRegistrySnapshot);

const useUserApps = (): readonly UserApp[] =>
  useSyncExternalStore(subscribeToUserApps, getUserAppsSnapshot);

type WorkspaceSidebarProps = {
  onSignIn?: () => void;
  onConnect?: () => void;
};

export function WorkspaceSidebar({
  onSignIn,
  onConnect,
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

  // Models/engine inline overlay, toggled by the footer Models button.
  const engineOpen = useEngineOverlayOpen();
  const [engineMounted, setEngineMounted] = useState(engineOpen);
  const [engineVisible, setEngineVisible] = useState(engineOpen);
  useEffect(() => {
    if (engineOpen) {
      setEngineMounted(true);
      let innerFrame = 0;
      const outerFrame = window.requestAnimationFrame(() => {
        innerFrame = window.requestAnimationFrame(() => setEngineVisible(true));
      });
      return () => {
        window.cancelAnimationFrame(outerFrame);
        if (innerFrame) window.cancelAnimationFrame(innerFrame);
      };
    }
    setEngineVisible(false);
    const timer = window.setTimeout(
      () => setEngineMounted(false),
      ENGINE_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [engineOpen]);

  return (
    <aside
      className="workspace-sidebar"
      data-platform={isMac ? "mac" : isWin ? "win" : "other"}
      aria-label="Sidebar"
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

          {showSearchInput ? (
            <div className="workspace-sidebar__search">
              <Search
                size={14}
                strokeWidth={1.85}
                className="workspace-sidebar__search-icon"
                aria-hidden="true"
              />
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
              className="workspace-sidebar__search-button"
              onClick={() => setSearchActive(true)}
            >
              <Search
                size={14}
                strokeWidth={1.85}
                className="workspace-sidebar__search-icon"
                aria-hidden="true"
              />
              <span>Search</span>
            </button>
          )}

          <WorkspacePanelOverview query={query} variant="overview" />
        </div>

        {engineMounted ? (
          <div
            className="workspace-sidebar__engine"
            data-visible={engineVisible || undefined}
          >
            <EngineTabContent />
          </div>
        ) : null}

        <div className="workspace-sidebar__footer">
          <DisplaySidebarModelsButton />
          <ShellTopBarAccount onSignIn={onSignIn} onConnect={onConnect} />
        </div>
      </div>
    </aside>
  );
}
