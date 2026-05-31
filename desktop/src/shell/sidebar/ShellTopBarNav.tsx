import { Link, useMatchRoute } from "@tanstack/react-router";
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
  badgeCount?: number;
  showHintDot?: boolean;
  onHintDismiss?: () => void;
}

const NavItem = ({
  app,
  badgeCount = 0,
  showHintDot = false,
  onHintDismiss,
}: NavItemProps) => {
  const matchRoute = useMatchRoute();
  const isActive = Boolean(matchRoute({ to: app.route, fuzzy: true }));
  const showActiveState = isActive && !app.suppressActiveState;

  const showBadge = badgeCount > 0;
  const badgeLabel = badgeCount > 99 ? "99+" : String(badgeCount);
  const showHint = showHintDot && !showBadge;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      preloadNavSurfaceRoute(app.id);
      if (showHint) onHintDismiss?.();
      if (isActive && app.onActiveClick) {
        event.preventDefault();
        app.onActiveClick();
      }
    },
    [isActive, app, showHint, onHintDismiss],
  );

  return (
    <Link
      to={app.route}
      className="shell-topbar-nav-item"
      data-active={showActiveState ? "true" : undefined}
      aria-current={showActiveState ? "page" : undefined}
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

export const ShellTopBarPrimaryNav = () => {
  const allApps = useRegisteredApps();
  const navApps = useMemo(
    () => allApps.filter((a) => !a.hideFromSidebar && a.slot === "top"),
    [allApps],
  );

  const { totalBadge: socialBadge } = useSocialBadges();
  const newAppsHint = useNewUserAppsHint();
  const matchRoute = useMatchRoute();
  const onAppsRoute = Boolean(matchRoute({ to: "/apps", fuzzy: true }));

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
