import { Link, useMatchRoute, useRouter } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { AppMetadata } from "@/app/_shared/app-metadata";
import { useSocialBadges } from "@/app/social/hooks/use-social-badges";
import {
  markAllUserAppsSeen,
  useNewUserAppsHint,
} from "@/app/_user/new-user-apps-hint";
import { preloadNavSurfaceRoute } from "@/shell/topbar/nav-surface-preloads";
import {
  getSnapshot as getAppRegistrySnapshot,
  subscribe as subscribeToAppRegistry,
} from "./app-registry";
import "./topbar-nav.css";

// App discovery happens in `./app-registry`, which owns the glob over
// `desktop/src/app/<id>/metadata.ts` and exposes a subscribable snapshot.
const useRegisteredApps = (): readonly AppMetadata[] =>
  useSyncExternalStore(subscribeToAppRegistry, getAppRegistrySnapshot);

interface NavItemProps {
  app: AppMetadata;
  /** Route-matched (drives re-entry click + selected text/aria). */
  active: boolean;
  badgeCount?: number;
  showHintDot?: boolean;
  onHintDismiss?: () => void;
}

const NavItem = ({
  app,
  active,
  badgeCount = 0,
  showHintDot = false,
  onHintDismiss,
}: NavItemProps) => {
  const showBadge = badgeCount > 0;
  const badgeLabel = badgeCount > 99 ? "99+" : String(badgeCount);
  const showHint = showHintDot && !showBadge;
  const router = useRouter();

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      preloadNavSurfaceRoute(app.id);
      if (showHint) onHintDismiss?.();
      if (active && app.onActiveClick) {
        event.preventDefault();
        app.onActiveClick();
        return;
      }
      // Entering from outside: the app may redirect its nav click (e.g.
      // Apps returning to the user's last-used app instead of the library).
      if (!active && app.resolveClickRoute) {
        const to = app.resolveClickRoute();
        if (to !== app.route) {
          event.preventDefault();
          void router.navigate({ to });
        }
      }
    },
    [active, app, router, showHint, onHintDismiss],
  );

  return (
    <Link
      to={app.route}
      className="shell-topbar-nav-item"
      data-active={active ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={handleClick}
      onFocus={() => preloadNavSurfaceRoute(app.id)}
      onMouseEnter={() => preloadNavSurfaceRoute(app.id)}
      title={showBadge ? `${app.label} (${badgeCount} unread)` : app.label}
      aria-label={showBadge ? `${app.label}, ${badgeCount} unread` : app.label}
    >
      <span className="shell-topbar-nav-label">{app.label}</span>
      {showBadge && (
        <span className="shell-topbar-nav-badge" aria-hidden="true">
          {badgeLabel}
        </span>
      )}
      {showHint && (
        <span className="shell-topbar-nav-hint-dot" aria-hidden="true" />
      )}
    </Link>
  );
};

/**
 * Deliberately unlinked from every bar: Store and Social are being reworked
 * and are not navigable from the UI for now. Their routes stay registered —
 * share cards and the social invite layer still deep-link into them.
 */
const UNLINKED_NAV_IDS: readonly string[] = ["store", "social"];

type ShellTopBarPrimaryNavProps = {
  /**
   * Nav entry ids to suppress. The full-window bar omits `apps`, whose
   * surface moved into the right sidebar; mobile still shows everything.
   */
  omitIds?: readonly string[];
};

export const ShellTopBarPrimaryNav = ({
  omitIds,
}: ShellTopBarPrimaryNavProps = {}) => {
  const allApps = useRegisteredApps();
  const navApps = useMemo(
    () =>
      allApps.filter(
        (a) =>
          !a.hideFromSidebar &&
          a.slot === "top" &&
          !UNLINKED_NAV_IDS.includes(a.id) &&
          !(omitIds?.includes(a.id) ?? false),
      ),
    [allApps, omitIds],
  );

  const { totalBadge: socialBadge } = useSocialBadges();
  const newAppsHint = useNewUserAppsHint();
  const matchRoute = useMatchRoute();
  const onAppsRoute = Boolean(matchRoute({ to: "/apps", fuzzy: true }));

  // The route-matched app drives the re-entry click + the plain-text
  // selected state (stronger color + weight — deliberately no pill fill).
  const matchedApp = navApps.find((a) =>
    Boolean(matchRoute({ to: a.route, fuzzy: true })),
  );
  const matchedId = matchedApp?.id ?? null;

  useEffect(() => {
    if (newAppsHint.active && onAppsRoute) {
      markAllUserAppsSeen();
    }
  }, [newAppsHint.active, onAppsRoute]);

  const badgeFor = useCallback(
    (app: AppMetadata) => (app.id === "social" ? socialBadge : 0),
    [socialBadge],
  );
  const hintFor = useCallback(
    (app: AppMetadata) => {
      if (app.id === "apps") return newAppsHint.active;
      return false;
    },
    [newAppsHint.active],
  );

  return (
    <nav className="shell-topbar-nav" aria-label="Apps">
      {navApps.map((app) => (
        <NavItem
          key={app.id}
          app={app}
          active={matchedId === app.id}
          badgeCount={badgeFor(app)}
          showHintDot={hintFor(app)}
          onHintDismiss={() => {
            if (app.id === "apps") markAllUserAppsSeen();
          }}
        />
      ))}
    </nav>
  );
};
