/**
 * The keep-alive decisions for user apps, as plain functions.
 *
 * `PersistentUserAppsHost` owns the timers and the React state; this owns the
 * rules — which apps stay mounted, which of them are counting down, and which
 * one may receive global input. The last rule is the one with teeth: a mounted
 * app the user cannot see still holds its `window` keydown bindings, so getting
 * it wrong doesn't look broken, it just quietly eats what the user types into
 * chat.
 */

import type { SidebarSection } from "@/features/workspace-display/sidebar-sections";

/**
 * How long a user app stays mounted (hidden) after the user leaves it before
 * it is torn down. Leaving hides the app instead of unmounting it; returning
 * within this window restores it exactly as left (state, scroll, media) and
 * resets the clock. Only a long *continuous* absence unmounts the app.
 */
export const USER_APP_TEARDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * How many user apps are kept alive at once, most-recently-used first.
 * Opening more apps than this evicts (unmounts) the least recently used.
 */
export const MAX_RETAINED_USER_APPS = 3;

/** Move `slug` to the front of the MRU list, evicting past the retention cap. */
export const promoteRetainedUserApp = (
  retained: readonly string[],
  slug: string,
): readonly string[] => {
  if (retained[0] === slug) return retained;
  return [slug, ...retained.filter((entry) => entry !== slug)].slice(
    0,
    MAX_RETAINED_USER_APPS,
  );
};

/**
 * The retained apps whose teardown clock should be running: everything except
 * the one the user is inside. Reopening the Apps section has to land back on
 * that app, so it never counts down while it is the section's location.
 */
export const countingDownUserApps = (
  retained: readonly string[],
  activeSlug: string | null,
): readonly string[] => retained.filter((slug) => slug !== activeSlug);

/**
 * The slugs to render this pass. The active app is included even before the
 * retention state has caught up with it, so opening an app never costs a blank
 * frame; the eviction cap still applies.
 */
export const mountedUserApps = (
  retained: readonly string[],
  activeSlug: string | null,
): readonly string[] =>
  activeSlug === null || retained.includes(activeSlug)
    ? retained
    : [activeSlug, ...retained].slice(0, MAX_RETAINED_USER_APPS);

export type UserAppInputContext = {
  /** The Apps section's sub-location — the app the user is inside, if any. */
  activeSlug: string | null;
  activeSection: SidebarSection;
  panelOpen: boolean;
};

/**
 * Which app's global input listeners may fire.
 *
 * Being the Apps section's location is not enough. The panel can close, and
 * the user can switch to Files or Search, without the location changing at all
 * — that is the whole point of per-section memory. In both cases the app is
 * still mounted and still bound to `window`, so input liveness has to key off
 * the app actually being on screen, not off where the section points.
 */
export const liveUserAppInputSlug = ({
  activeSlug,
  activeSection,
  panelOpen,
}: UserAppInputContext): string | null =>
  panelOpen && activeSection === "apps" ? activeSlug : null;
