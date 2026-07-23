import { useMatchRoute } from "@tanstack/react-router";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { LoaderCircle } from "@/ui/icons";
import {
  getSnapshot,
  subscribe,
  type UserAppModule,
} from "@/app/_user/user-apps-registry";
import {
  clearLastUserAppSlug,
  recordLastUserAppSlug,
} from "./last-user-app-location";
import {
  installUserAppInputGate,
  setInputActiveUserApp,
} from "./user-app-input-gate";

// Patch window/document global-input listener registration before any user
// app module can run (apps are lazy children of this host, so this module
// always evaluates first). Retained-hidden apps' global input listeners
// no-op unless the app opts in via `meta.backgroundInput` — see
// `user-app-input-gate.ts` for the full contract.
installUserAppInputGate();

/**
 * How long a user app stays mounted (hidden) after the user navigates away
 * before it is torn down. Navigating away hides the app instead of
 * unmounting it; returning within this window restores it exactly as left
 * (state, scroll, media) and resets the clock. Only a long *continuous*
 * absence unmounts the app.
 */
export const USER_APP_TEARDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * How many user apps are kept alive at once, most-recently-used first.
 * Opening more apps than this evicts (unmounts) the least recently used.
 */
const MAX_RETAINED_USER_APPS = 3;

/**
 * One lazy component per registry loader, keyed by loader identity. When a
 * `_user` file is edited, the registry module hot-reloads and mints new
 * loader functions, so retained apps swap to a freshly loaded component —
 * fresh code wins over retained state in dev, matching the pre-keep-alive
 * behavior where leaving and returning picked up the new module.
 */
const lazyComponentCache = new WeakMap<
  () => Promise<UserAppModule>,
  ComponentType
>();

const lazyComponentFor = (
  load: () => Promise<UserAppModule>,
): ComponentType => {
  let component = lazyComponentCache.get(load);
  if (!component) {
    component = lazy(() => load().then((mod) => ({ default: mod.default })));
    lazyComponentCache.set(load, component);
  }
  return component;
};

/**
 * Keep-alive host for user apps (`/apps/$slug`). Mounted once in the root
 * shell — outside the router outlet, same pattern as the persistent chat
 * surface — so navigating to another route hides the app subtree instead of
 * unmounting it. Hidden apps sit under `visibility: hidden` +
 * `content-visibility: hidden`, so rendering work is skipped and
 * element-visibility signals (IntersectionObserver etc.) read as offscreen,
 * while DOM state (scroll positions, media elements) is preserved.
 *
 * Teardown happens through React unmount (the retained entry is dropped),
 * so app effects clean up object URLs and listeners normally.
 */
export function PersistentUserAppsHost() {
  const apps = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const matchRoute = useMatchRoute();
  const match = matchRoute({ to: "/apps/$slug" });
  const activeSlug = match ? match.slug : null;
  const onAppsLibrary = Boolean(matchRoute({ to: "/apps" }));
  const isActiveApp =
    activeSlug !== null && apps.some((app) => app.slug === activeSlug);

  const [retained, setRetained] = useState<readonly string[]>([]);
  const teardownTimersRef = useRef(new Map<string, number>());

  // Tell the input gate which app is visible. Layout effect so the flip
  // happens synchronously with the route commit — the returning app's
  // bindings work immediately; the hidden app's go quiet immediately.
  useLayoutEffect(() => {
    setInputActiveUserApp(isActiveApp && activeSlug !== null ? activeSlug : null);
  }, [activeSlug, isActiveApp]);
  useEffect(() => () => setInputActiveUserApp(null), []);

  // Remember the most recent apps-area location so the sidebar Apps entry
  // can return to the app the user was inside. Visiting the library clears
  // it — Apps then goes to the library again.
  useEffect(() => {
    if (isActiveApp && activeSlug !== null) recordLastUserAppSlug(activeSlug);
    else if (onAppsLibrary) clearLastUserAppSlug();
  }, [activeSlug, isActiveApp, onAppsLibrary]);

  // Promote the active app to the front of the retained MRU list.
  useEffect(() => {
    if (!isActiveApp || activeSlug === null) return;
    setRetained((prev) => {
      if (prev[0] === activeSlug) return prev;
      return [activeSlug, ...prev.filter((slug) => slug !== activeSlug)].slice(
        0,
        MAX_RETAINED_USER_APPS,
      );
    });
  }, [activeSlug, isActiveApp]);

  // The active app never counts down. Every retained-but-hidden app gets a
  // teardown timer; returning to it (or eviction) clears the timer.
  useEffect(() => {
    const timers = teardownTimersRef.current;
    for (const [slug, id] of timers) {
      if (slug === activeSlug || !retained.includes(slug)) {
        window.clearTimeout(id);
        timers.delete(slug);
      }
    }
    for (const slug of retained) {
      if (slug === activeSlug || timers.has(slug)) continue;
      const id = window.setTimeout(() => {
        timers.delete(slug);
        setRetained((prev) => prev.filter((s) => s !== slug));
      }, USER_APP_TEARDOWN_MS);
      timers.set(slug, id);
    }
  }, [activeSlug, retained]);

  useEffect(() => {
    const timers = teardownTimersRef.current;
    return () => {
      for (const id of timers.values()) window.clearTimeout(id);
      timers.clear();
    };
  }, []);

  // Render the active app immediately (before the retention effect commits)
  // so there is no blank frame on first navigation into an app.
  const mounted =
    isActiveApp && activeSlug !== null && !retained.includes(activeSlug)
      ? [activeSlug, ...retained].slice(0, MAX_RETAINED_USER_APPS)
      : retained;

  return (
    <>
      {mounted.map((slug) => {
        const app = apps.find((entry) => entry.slug === slug);
        // App file deleted while retained — let it unmount naturally.
        if (!app) return null;
        const Component = lazyComponentFor(app.load);
        const isActive = slug === activeSlug;
        return (
          <div
            key={slug}
            className={`persistent-user-app-surface${isActive ? " persistent-user-app-surface--active" : ""}`}
            aria-hidden={!isActive}
            inert={!isActive}
          >
            <Suspense
              fallback={
                isActive ? (
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <LoaderCircle
                      className="stella-loader-circle"
                      size={18}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </div>
                ) : null
              }
            >
              <Component />
            </Suspense>
          </div>
        );
      })}
    </>
  );
}
