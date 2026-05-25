import type { ComponentType } from "react";

/**
 * Reactive registry of user apps that Stella has built for the user.
 *
 * Each user app is a single `.tsx` file in this folder:
 *
 *   desktop/src/app/_user/<slug>.tsx
 *
 * exporting:
 *
 *   export const meta = { label: string; createdAt: string };
 *   export default function App() { ... }
 *
 * The directory prefix `_` keeps these files out of the top-bar nav
 * (the sidebar registry filters folders starting with `_`). Discovery
 * here is purely for the `/apps` page (list, search, sort) and the
 * `/apps/$slug` dynamic route.
 *
 * `meta` is loaded eagerly via `import.meta.glob({ eager: true, import: "meta" })`
 * so the list can render and sort without a round of dynamic imports.
 * The component itself stays lazy: `load()` returns the module promise
 * and `/apps/$slug` consumes it through `React.lazy`.
 *
 * HMR: when a user app file is added, removed, or edited, Vite re-runs
 * this module and we notify subscribers via `useSyncExternalStore`. No
 * full reload, no lost route state. Same shape as `shell/sidebar/app-registry.ts`.
 */

export type UserAppMeta = {
  label: string;
  createdAt: string;
};

export type UserAppModule = {
  default: ComponentType;
  meta: UserAppMeta;
};

export type UserApp = {
  slug: string;
  meta: UserAppMeta;
  load: () => Promise<UserAppModule>;
};

const META_MODULES = import.meta.glob<UserAppMeta>("./*.tsx", {
  eager: true,
  import: "meta",
});

const LAZY_MODULES = import.meta.glob<UserAppModule>("./*.tsx");

const slugFromPath = (path: string): string =>
  path.replace(/^\.\//, "").replace(/\.tsx$/, "");

const isValidMeta = (value: unknown): value is UserAppMeta => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UserAppMeta>;
  return (
    typeof candidate.label === "string" &&
    typeof candidate.createdAt === "string"
  );
};

const computeSnapshot = (): readonly UserApp[] => {
  const apps: UserApp[] = [];
  for (const [path, meta] of Object.entries(META_MODULES)) {
    if (!isValidMeta(meta)) continue;
    const slug = slugFromPath(path);
    const loader = LAZY_MODULES[path];
    if (!loader) continue;
    apps.push({ slug, meta, load: loader });
  }
  apps.sort((a, b) => a.slug.localeCompare(b.slug));
  return apps;
};

let cachedSnapshot: readonly UserApp[] = computeSnapshot();
const subscribers = new Set<() => void>();

export const subscribe = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
};

export const getSnapshot = (): readonly UserApp[] => cachedSnapshot;

export const getUserApp = (slug: string): UserApp | undefined =>
  cachedSnapshot.find((app) => app.slug === slug);

if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    if (!newModule) return;
    const next = newModule.getSnapshot?.() as readonly UserApp[] | undefined;
    if (!next) return;
    cachedSnapshot = next;
    for (const cb of subscribers) {
      try {
        cb();
      } catch {
        // Subscribers must never break the registry.
      }
    }
  });
}
