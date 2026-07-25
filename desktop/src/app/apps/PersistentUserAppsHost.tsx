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
  useActiveSidebarSection,
  useSidebarSectionLocation,
} from "@/features/workspace-display/sidebar-sections";
import { useDisplayPanelOpen } from "@/features/workspace-display/tab-store";
import {
  countingDownUserApps,
  liveUserAppInputSlug,
  mountedUserApps,
  promoteRetainedUserApp,
  USER_APP_TEARDOWN_MS,
} from "./user-app-keep-alive";
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
 * Keep-alive host for user apps. Mounted once, inside the Apps sidebar
 * section — which itself is never unmounted, not even when the panel closes —
 * so an app survives switching sections, closing the panel and navigating the
 * main content area. It is deliberately *not* a child of anything keyed by the
 * open slug and never portalled: React portals preserve component state but
 * move the DOM node, which destroys iframe browsing contexts and resets
 * `<video>`/`<canvas>` and scroll. Every surface is mounted in its final home
 * and only ever hidden.
 *
 * Hidden apps sit under `visibility: hidden` + `content-visibility: hidden`,
 * so rendering work is skipped and element-visibility signals
 * (IntersectionObserver etc.) read as offscreen, while DOM state (scroll
 * positions, media elements) is preserved.
 *
 * Teardown happens through React unmount (the retained entry is dropped),
 * so app effects clean up object URLs and listeners normally.
 */
export function PersistentUserAppsHost() {
  const apps = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const openSlug = useSidebarSectionLocation("apps");
  const activeSection = useActiveSidebarSection();
  const panelOpen = useDisplayPanelOpen();
  // A remembered slug outlives its file: locations persist across launches,
  // the registry does not. The registry has the final say, and an app that no
  // longer exists degrades to the library rather than to a broken surface.
  const activeSlug =
    openSlug !== null && apps.some((app) => app.slug === openSlug)
      ? openSlug
      : null;

  const [retained, setRetained] = useState<readonly string[]>([]);
  const teardownTimersRef = useRef(new Map<string, number>());

  // Tell the input gate which app is reachable by the keyboard. Layout effect
  // so the flip commits with the section change — the returning app's
  // bindings work immediately; the leaving app's go quiet immediately.
  const inputSlug = liveUserAppInputSlug({
    activeSlug,
    activeSection,
    panelOpen,
  });
  useLayoutEffect(() => {
    setInputActiveUserApp(inputSlug);
  }, [inputSlug]);
  useEffect(() => () => setInputActiveUserApp(null), []);

  // Promote the active app to the front of the retained MRU list.
  useEffect(() => {
    if (activeSlug === null) return;
    setRetained((prev) => promoteRetainedUserApp(prev, activeSlug));
  }, [activeSlug]);

  // Every retained app the user is not inside gets a teardown timer;
  // returning to it (or eviction) clears the timer.
  useEffect(() => {
    const timers = teardownTimersRef.current;
    const countingDown = new Set(countingDownUserApps(retained, activeSlug));
    for (const [slug, id] of timers) {
      if (countingDown.has(slug)) continue;
      window.clearTimeout(id);
      timers.delete(slug);
    }
    for (const slug of countingDown) {
      if (timers.has(slug)) continue;
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

  return (
    <>
      {mountedUserApps(retained, activeSlug).map((slug) => {
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
