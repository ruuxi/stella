import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * App router. Uses memory history because Stella ships in Electron — there's
 * no browser URL bar to surface or guard with `file://` quirks. Location is
 * persisted to renderer-side `localStorage` (see
 * `@/shared/lib/last-location` and the restore/persist effects in
 * `__root.tsx`) so it survives reloads and window restarts.
 */
export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/chat"] }),
  defaultPreload: false,
  scrollRestoration: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
