import type { AppMetadata } from "@/app/_shared/app-metadata";

/**
 * Reactive registry of sidebar apps discovered from
 * `desktop/src/app/<id>/metadata.ts` files via `import.meta.glob`.
 *
 * The glob lives here (not in `Sidebar.tsx`) so that adding a new
 * `metadata.ts` file invalidates only this leaf module rather than
 * propagating up through Sidebar to `__root.tsx`. The HMR accept handler
 * below catches the invalidation, recomputes the snapshot, and notifies
 * subscribers via `useSyncExternalStore` -- no full renderer reload, no
 * lost React state, no morph cover needed for the create-app case.
 *
 * `Sidebar.tsx` reads via `useSyncExternalStore(subscribe, getSnapshot)`.
 *
 * Production builds: `import.meta.hot` is undefined, so the accept block
 * is a no-op. The snapshot is computed once at module load and never
 * changes -- which is correct for a non-self-modifying production build.
 */

const APP_MODULES = import.meta.glob<{ default: AppMetadata }>(
  "../../app/*/metadata.ts",
  { eager: true },
);

const computeSnapshot = (
  modules: Record<string, { default: AppMetadata }>,
): readonly AppMetadata[] =>
  Object.values(modules)
    .map((m) => m.default)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

let cachedSnapshot: readonly AppMetadata[] = computeSnapshot(APP_MODULES);
const subscribers = new Set<() => void>();

export const subscribe = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
};

/**
 * Returns the current registered apps. Reference is stable until the
 * underlying glob actually changes (HMR), satisfying React's
 * `useSyncExternalStore` invariant.
 */
export const getSnapshot = (): readonly AppMetadata[] => cachedSnapshot;

if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    if (!newModule) return;
    // Re-evaluating the new module's `APP_MODULES` is the safest way to
    // pick up additions/removals: Vite's `importGlob` plugin re-globs
    // the filesystem when its `hotUpdate` runs, so the new module's
    // exports reflect the updated set. Recomputing the snapshot from the
    // new module ensures stable reference semantics for the consumer.
    const next = newModule.getSnapshot?.() as readonly AppMetadata[] | undefined;
    if (!next) return;
    cachedSnapshot = next;
    for (const cb of subscribers) {
      try {
        cb();
      } catch {
        // Subscribers throwing should never break the registry.
      }
    }
  });
}
