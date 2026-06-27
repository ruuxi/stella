/**
 * Persistent floating left sidebar — the consolidated index.
 *
 * Top-to-bottom: primary nav (Home / Apps / Store / Social) and the
 * Activity / Files / Schedule sections (`LeftSidebarSections`). Nav rows
 * navigate the center content; section items open the right sidebar viewer
 * (master-detail). Search now lives in the composer activity pill's tray,
 * not here.
 *
 * Full window only — the mini window keeps its own chrome.
 */

import { useMemo, useSyncExternalStore } from "react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import type { AppMetadata } from "@/app/_shared/app-metadata";
import {
  getSnapshot as getAppRegistrySnapshot,
  subscribe as subscribeToAppRegistry,
} from "@/shell/sidebar/app-registry";
import { getPlatform } from "@/platform/electron/platform";
import { LeftSidebarSections } from "@/shell/LeftSidebarSections";
import { ShellTopBarAccount } from "@/shell/sidebar/ShellTopBarAccount";
import { ShellTopBarUpdatePill } from "@/shell/ShellTopBarUpdatePill";
import "./left-sidebar.css";
import "./shell-junction.css";

const useRegisteredApps = (): readonly AppMetadata[] =>
  useSyncExternalStore(subscribeToAppRegistry, getAppRegistrySnapshot);

type LeftSidebarProps = {
  onSignIn?: () => void;
  onConnect?: () => void;
  /** When true, the sidebar animates its width to 0 (stays mounted). */
  collapsed?: boolean;
};

export function LeftSidebar({
  onSignIn,
  onConnect,
  collapsed = false,
}: LeftSidebarProps) {
  const allApps = useRegisteredApps();
  const matchRoute = useMatchRoute();
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";

  // Primary nav: top-slot apps (Home / Apps / Store / Social).
  const navApps = useMemo(
    () => allApps.filter((app) => !app.hideFromSidebar && app.slot === "top"),
    [allApps],
  );

  return (
    <aside
      className={`left-sidebar${collapsed ? " left-sidebar--collapsed" : ""}`}
      data-platform={isMac ? "mac" : isWin ? "win" : "other"}
      aria-label="Sidebar"
      aria-hidden={collapsed || undefined}
    >
      <div className="left-sidebar__frame">
        <div className="left-sidebar__chrome">
          <ShellTopBarUpdatePill />
          <div
            className="left-sidebar__chrome-spacer"
            aria-hidden="true"
          />
        </div>
        <div className="left-sidebar__scroll">
          {navApps.length > 0 ? (
            <nav className="left-sidebar__nav" aria-label="Navigation">
              {navApps.map((app) => {
                const active = Boolean(
                  matchRoute({ to: app.route, fuzzy: true }),
                );
                const Icon = app.icon;
                return (
                  <Link
                    key={app.id}
                    to={app.route}
                    className="left-sidebar__nav-row"
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
                      className="left-sidebar__nav-icon"
                      aria-hidden="true"
                    >
                      <Icon size={16} />
                    </span>
                    <span className="left-sidebar__nav-label">
                      {app.label}
                    </span>
                  </Link>
                );
              })}
            </nav>
          ) : null}

          <LeftSidebarSections variant="overview" showRunning={false} />
        </div>

        <div className="left-sidebar__footer">
          <ShellTopBarAccount onSignIn={onSignIn} onConnect={onConnect} />
        </div>
      </div>
    </aside>
  );
}
