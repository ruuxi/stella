import { Link, useMatchRoute } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
  registerRef: (id: string, el: HTMLAnchorElement | null) => void;
}

const NavItem = ({
  app,
  active,
  badgeCount = 0,
  showHintDot = false,
  onHintDismiss,
  registerRef,
}: NavItemProps) => {
  const showBadge = badgeCount > 0;
  const badgeLabel = badgeCount > 99 ? "99+" : String(badgeCount);
  const showHint = showHintDot && !showBadge;

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      preloadNavSurfaceRoute(app.id);
      if (showHint) onHintDismiss?.();
      if (active && app.onActiveClick) {
        event.preventDefault();
        app.onActiveClick();
      }
    },
    [active, app, showHint, onHintDismiss],
  );

  return (
    <Link
      ref={(el) => registerRef(app.id, el)}
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

  // The route-matched app drives the re-entry click + selected text; the
  // sliding "thumb" only paints when that app also wants the selected state.
  const matchedApp = navApps.find((a) =>
    Boolean(matchRoute({ to: a.route, fuzzy: true })),
  );
  const matchedId = matchedApp?.id ?? null;
  const selectedId =
    matchedApp && !matchedApp.suppressActiveState ? matchedApp.id : null;

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

  // --- Sliding selection thumb -------------------------------------------
  const navRef = useRef<HTMLElement>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement>());
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(
    null,
  );
  const [thumbVisible, setThumbVisible] = useState(false);
  // Suppress the slide animation on first paint so the thumb appears under
  // the active item instead of sweeping in from the left edge.
  const [animate, setAnimate] = useState(false);

  const registerRef = useCallback(
    (id: string, el: HTMLAnchorElement | null) => {
      if (el) itemRefs.current.set(id, el);
      else itemRefs.current.delete(id);
    },
    [],
  );

  const measure = useCallback(() => {
    const el = selectedId ? itemRefs.current.get(selectedId) ?? null : null;
    if (!el) {
      setThumbVisible(false);
      return;
    }
    // Keep the last known geometry while hiding so it never collapses to 0.
    setThumb({ left: el.offsetLeft, width: el.offsetWidth });
    setThumbVisible(true);
  }, [selectedId]);

  useLayoutEffect(() => {
    measure();
  }, [measure, navApps]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(nav);
    itemRefs.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [measure, navApps]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
    };
  }, [measure]);

  return (
    <nav ref={navRef} className="shell-topbar-nav" aria-label="Apps">
      <span
        className="shell-topbar-nav-thumb"
        data-animate={animate ? "true" : undefined}
        data-visible={thumbVisible ? "true" : undefined}
        aria-hidden="true"
        style={
          thumb
            ? {
                transform: `translateX(${thumb.left}px)`,
                width: `${thumb.width}px`,
              }
            : undefined
        }
      />
      {navApps.map((app) => (
        <NavItem
          key={app.id}
          app={app}
          active={matchedId === app.id}
          badgeCount={badgeFor(app)}
          showHintDot={hintFor(app)}
          registerRef={registerRef}
          onHintDismiss={() => {
            if (app.id === "apps") markAllUserAppsSeen();
          }}
        />
      ))}
    </nav>
  );
};
