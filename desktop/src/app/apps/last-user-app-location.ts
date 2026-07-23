import { getUserApp } from "@/app/_user/user-apps-registry";
import { uiState } from "@/platform/ui-state";

/**
 * Remembers the user's most recent apps-area location so the sidebar
 * "Apps" entry can return them to the app they were using (which the
 * keep-alive host in the root shell may still have mounted) instead of
 * always landing on the `/apps` library.
 *
 * Written by `<PersistentUserAppsHost />` on every apps-area router
 * resolution: visiting `/apps/<slug>` records the slug; visiting the
 * `/apps` library clears it (the library was the most recent apps-area
 * location, so Apps should go there). Stored in the shared UI state
 * store — the same mechanism as the shell's last-location persistence —
 * so it survives reloads within a session.
 */
const LAST_USER_APP_SLUG_KEY = "stella.apps.lastUserAppSlug";

export const recordLastUserAppSlug = (slug: string): void => {
  uiState.setItem(LAST_USER_APP_SLUG_KEY, slug);
};

export const clearLastUserAppSlug = (): void => {
  uiState.removeItem(LAST_USER_APP_SLUG_KEY);
};

/**
 * The route the Apps nav entry should navigate to: the last user app the
 * user was inside (`/apps/<slug>`), or `null` when the library is the
 * right destination (no recorded app, the app was removed, or the
 * library was visited more recently).
 */
export const getLastUserAppRoute = (): string | null => {
  const slug = uiState.getItem(LAST_USER_APP_SLUG_KEY);
  if (!slug || !getUserApp(slug)) return null;
  return `/apps/${slug}`;
};
