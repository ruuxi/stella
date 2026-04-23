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
  defaultPreload: false,
  scrollRestoration: false,
  defaultErrorComponent: ({ error, info }) => (
    <CrashSurface
      error={error instanceof Error ? error : new Error(String(error))}
      componentStack={info?.componentStack ?? null}
    />
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
