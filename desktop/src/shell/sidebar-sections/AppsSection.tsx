/**
 * Apps — the user-app library, and the apps themselves.
 *
 * Sub-location (`sidebarSections` → `locations.apps`) is a user-app slug, or
 * `null` for the library list.
 *
 * `<PersistentUserAppsHost />` renders here as a sibling of the library, not
 * inside the branch that shows the open app, and it is never conditioned on
 * which app is open. App surfaces have to be mounted in their final home and
 * only ever hidden: portalling or re-parenting a live subtree preserves React
 * state but destroys iframe browsing contexts and resets `<video>`/`<canvas>`
 * and scroll position. Everything about where the host sits in this tree
 * exists to keep its DOM nodes still.
 */

import { useEffect, useSyncExternalStore } from "react";
import { PersistentUserAppsHost } from "@/app/apps/PersistentUserAppsHost";
import {
  formatUserAppCreatedAt,
  listUserApps,
  useRequestUserApp,
} from "@/app/apps/user-app-library";
import {
  getSnapshot,
  subscribe,
  type UserApp,
} from "@/app/_user/user-apps-registry";
import { markAllUserAppsSeen } from "@/app/_user/new-user-apps-hint";
import {
  sidebarSections,
  useActiveSidebarSection,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import { ChevronLeft } from "@/ui/icons";
import "./apps-section.css";

export function AppsSection() {
  const apps = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const openSlug = useSidebarSectionLocation("apps");
  const activeSection = useActiveSidebarSection();
  const panelOpen = useDisplayPanelOpen();

  // A remembered slug can outlive its file — locations persist across
  // launches, the registry does not — so an app that no longer exists falls
  // back to the library.
  const openApp = openSlug
    ? (apps.find((app) => app.slug === openSlug) ?? null)
    : null;

  // The list counts as "seen" only when the user can actually see it: every
  // section stays mounted, so mounting alone says nothing about attention.
  const listVisible = panelOpen && activeSection === "apps" && !openApp;
  useEffect(() => {
    if (listVisible) markAllUserAppsSeen();
  }, [apps, listVisible]);

  return (
    <>
      {openApp ? (
        <div className="sidebar-section__viewer-head">
          <button
            type="button"
            className="sidebar-section__back"
            onClick={() => sidebarSections.clearLocation("apps")}
            aria-label="Back to apps"
          >
            <ChevronLeft size={15} strokeWidth={1.75} aria-hidden="true" />
            Apps
          </button>
          <span className="sidebar-section__viewer-title">
            {openApp.meta.label}
          </span>
        </div>
      ) : null}
      <div className="apps-section__body">
        {openApp ? null : <AppsLibrary apps={apps} />}
        <PersistentUserAppsHost />
      </div>
    </>
  );
}

function AppsLibrary({ apps }: { apps: readonly UserApp[] }) {
  const requestUserApp = useRequestUserApp();

  if (apps.length === 0) {
    return (
      <div className="apps-section__library apps-section__library--empty">
        <p className="apps-section__empty-title">Nothing here yet.</p>
        <p className="apps-section__empty-body">
          Ask Stella to build a small app. It will show up here.
        </p>
        <button
          type="button"
          className="pill-btn pill-btn--primary"
          onClick={requestUserApp}
        >
          Ask Stella to create an app
        </button>
      </div>
    );
  }

  const visible = listUserApps(apps, "", "recent");

  return (
    <div className="apps-section__library">
      <ul className="apps-section__grid sidebar-section__scroll">
        {visible.map((app) => (
          <li key={app.slug}>
            <button
              type="button"
              className="apps-section__card"
              onClick={() => sidebarSections.setLocation("apps", app.slug)}
            >
              <span className="apps-section__card-label">{app.meta.label}</span>
              <span className="apps-section__card-meta">
                {formatUserAppCreatedAt(app.meta.createdAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="apps-section__footer">
        <button type="button" className="pill-btn" onClick={requestUserApp}>
          Create an app
        </button>
      </div>
    </div>
  );
}
