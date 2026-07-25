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
 * The retained apps whose teardown clock should be running: everything the
 * user is not currently looking at. An app that is merely *remembered* — the
 * section still points at it, but the panel is closed or showing Files —
 * counts down like any other, because that is exactly the absence the clock
 * is measuring.
 */
export const countingDownUserApps = (
  retained: readonly string[],
  onScreenSlug: string | null,
): readonly string[] => retained.filter((slug) => slug !== onScreenSlug);

/**
 * The slugs to render this pass. The on-screen app is included even before the
 * retention state has caught up with it, so opening an app never costs a blank
 * frame; the eviction cap still applies.
 *
 * Keying this on the on-screen app rather than the remembered one also keeps a
 * restored location off the startup path: the persisted slug does not fetch its
 * chunk and run its mount effects until the user actually opens the section.
 */
export const mountedUserApps = (
  retained: readonly string[],
  onScreenSlug: string | null,
): readonly string[] =>
  onScreenSlug === null || retained.includes(onScreenSlug)
    ? retained
    : [onScreenSlug, ...retained].slice(0, MAX_RETAINED_USER_APPS);

export type UserAppVisibilityContext = {
  /** The Apps section's sub-location — the app the user is inside, if any. */
  activeSlug: string | null;
  activeSection: SidebarSection;
  panelOpen: boolean;
};

/**
 * The one app that is actually on screen, if any.
 *
 * Being the Apps section's location is not enough. The panel can close, and the
 * user can switch to Files or Search, without the location changing at all —
 * that is the whole point of per-section memory. A remembered app is still
 * mounted, still bound to `window`, and still painting.
 *
 * Every question that means "is the user looking at this app" resolves through
 * here: whether it may receive global input, whether it renders or is skipped
 * with `content-visibility`, and whether its teardown clock runs. Answering
 * those three differently is what lets a hidden app quietly eat keystrokes,
 * composite forever, and never time out.
 */
export const onScreenUserAppSlug = ({
  activeSlug,
  activeSection,
  panelOpen,
}: UserAppVisibilityContext): string | null =>
  panelOpen && activeSection === "apps" ? activeSlug : null;
