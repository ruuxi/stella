import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { CrashSurface } from "./shell/CrashSurface";
import { routeTree } from "./routeTree.gen";

/**
 * App router. Uses memory history because Stella ships in Electron — there's
 * no browser URL bar to surface or guard with `file://` quirks. Location is
 * persisted to renderer-side `localStorage` (see
 * `@/shared/lib/last-location` and the restore/persist effects in
 * `__root.tsx`) so it survives reloads and window restarts.
 *
 * `defaultErrorComponent` matters: TanStack Router intercepts render-time and
 * loader errors before they bubble to React's `<ErrorBoundary>`, so without
 * this, route crashes render the library's tiny default fallback (and log a
 * "wasn't caught by any route" warning). We render the same `CrashSurface`
 * the React boundary uses so the user always sees one consistent screen.
 */
export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/chat"] }),
  // `defaultPreload: "intent"` covers `<Link>` hover/focus on actual route
  // boundaries (chat / social / store / settings / billing / c.$handle).
  // The hand-rolled `runOnce` cache in `@/shared/lib/sidebar-preloads`
  // covers everything *not* in the route graph — popovers, dialogs,
  // social subdialogs, billing query bundle — so the two layers are
  // complementary, not redundant. Don't drop either.
  //
  // `defaultPendingMs` / `defaultPendingMinMs` are deliberately left at
  // TSR's defaults (1000 / 500). Intent preload + idle prefetch mean the
  // pending state effectively never triggers on a real navigation, so
  // there's no win to overriding them — and a future route-level
  // `pendingComponent` would otherwise flash without the usual debounce.
  defaultPreload: "intent",
  defaultPreloadDelay: 0,
  defaultPreloadStaleTime: Number.POSITIVE_INFINITY,
  scrollRestoration: false,
  defaultErrorComponent: ({ error, info }) => (
    <CrashSurface
      error={error instanceof Error ? error : new Error(String(error))}
      componentStack={info?.componentStack ?? null}
    />
  ),
});

// HMR boundary for `routeTree.gen.ts`. The TanStack Router Vite plugin
// regenerates that file whenever a route is added, removed, or renamed.
// Without this accept handler, the new module would propagate up to
// every importer of `router` (FullShell, etc.) and force a full renderer
// reload -- visible to the user as a blank flash, even when covered by
// the morph overlay.
//
// Swapping the tree on the existing router instance keeps every
// subscriber, navigation, and route-state intact: only the route graph
// updates. New routes become reachable immediately; deleted routes
// stop being matchable on the next navigation.
if (import.meta.hot) {
  import.meta.hot.accept("./routeTree.gen.ts", (newModule) => {
    const next = (newModule as { routeTree?: unknown } | undefined)?.routeTree;
    if (!next) return;
    // `router.update` accepts the same options as `createRouter`, but
    // applied to the live instance. TanStack handles re-resolving the
    // current location against the new tree.
    router.update({ routeTree: next as typeof routeTree });
    void router.invalidate();
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
