import { useSyncExternalStore } from "react";

import {
  getSnapshot as getUserAppsSnapshot,
  subscribe as subscribeToUserApps,
} from "./user-apps-registry";

/**
 * Tiny "new app" marker on the Apps top-bar nav item. Mirrors the
 * post-onboarding hint shape but the trigger is dynamic: any user app
 * slug the user hasn't seen yet keeps the dot lit until they visit
 * `/apps`.
 *
 * Storage shape (single localStorage key):
 *   {
 *     initialized: boolean,           // false until the first seed
 *     seen: { [slug]: true }          // slugs the user has acknowledged
 *   }
 *
 * On the very first launch with this feature shipped, the seen set is
 * seeded from the current registry — that way existing apps don't all
 * pop a dot retroactively. After that, any new file in `_user/` whose
 * slug isn't in `seen` lights the nav dot until `/apps` is visited.
 */

const STORAGE_KEY = "stella:new-user-apps-seen";
const CHANGE_EVENT = "stella:new-user-apps-seen-changed";

type StoredState = {
  initialized: boolean;
  seen: Record<string, true>;
};

const EMPTY_STATE: StoredState = { initialized: false, seen: {} };

const safeRead = (): StoredState => {
  if (typeof window === "undefined") return EMPTY_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    if (typeof parsed !== "object" || parsed === null) return EMPTY_STATE;
    const seen =
      parsed.seen && typeof parsed.seen === "object"
        ? Object.fromEntries(
            Object.entries(parsed.seen).filter(
              ([, value]) => value === true,
            ),
          )
        : {};
    return {
      initialized: parsed.initialized === true,
      seen: seen as Record<string, true>,
    };
  } catch {
    return EMPTY_STATE;
  }
};

const safeWrite = (state: StoredState): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort; the dot is purely a one-time visual nudge.
  }
};

const subscribers = new Set<() => void>();
let listenersAttached = false;
let unsubscribeFromRegistry: (() => void) | null = null;

const handleStorageEvent = (event: StorageEvent) => {
  if (event.storageArea !== localStorage) return;
  if (event.key !== STORAGE_KEY) return;
  for (const notify of subscribers) notify();
};

const handleCustomEvent = () => {
  for (const notify of subscribers) notify();
};

const handleRegistryChange = () => {
  // A new app file appeared (or one was removed). The dot is derived
  // from the registry diff against the seen set, so just notify.
  for (const notify of subscribers) notify();
};

const attachListeners = () => {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  window.addEventListener("storage", handleStorageEvent);
  window.addEventListener(CHANGE_EVENT, handleCustomEvent);
  unsubscribeFromRegistry = subscribeToUserApps(handleRegistryChange);
};

const detachListeners = () => {
  if (!listenersAttached || typeof window === "undefined") return;
  if (subscribers.size > 0) return;
  listenersAttached = false;
  window.removeEventListener("storage", handleStorageEvent);
  window.removeEventListener(CHANGE_EVENT, handleCustomEvent);
  unsubscribeFromRegistry?.();
  unsubscribeFromRegistry = null;
};

const subscribe = (notify: () => void) => {
  subscribers.add(notify);
  attachListeners();
  return () => {
    subscribers.delete(notify);
    detachListeners();
  };
};

const notifyAll = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
  for (const notify of subscribers) notify();
};

const seedIfNeeded = (state: StoredState): StoredState => {
  if (state.initialized) return state;
  const seen: Record<string, true> = {};
  for (const app of getUserAppsSnapshot()) {
    seen[app.slug] = true;
  }
  const next: StoredState = { initialized: true, seen };
  safeWrite(next);
  return next;
};

/**
 * Marks every currently-registered user app as seen. Called when the
 * user visits `/apps` (any sub-route counts).
 */
export const markAllUserAppsSeen = (): void => {
  const current = safeRead();
  const nextSeen: Record<string, true> = { ...current.seen };
  let changed = !current.initialized;
  for (const app of getUserAppsSnapshot()) {
    if (!nextSeen[app.slug]) {
      nextSeen[app.slug] = true;
      changed = true;
    }
  }
  if (!changed) return;
  safeWrite({ initialized: true, seen: nextSeen });
  notifyAll();
};

/**
 * Test/reset helper — drops the entire seen set so the next visit to
 * `/apps` re-seeds. Not currently surfaced in the UI.
 */
export const clearNewUserAppsHint = (): void => {
  safeWrite(EMPTY_STATE);
  notifyAll();
};

const getHintSnapshot = (): boolean => {
  const state = seedIfNeeded(safeRead());
  for (const app of getUserAppsSnapshot()) {
    if (!state.seen[app.slug]) return true;
  }
  return false;
};

const getServerSnapshot = () => false;

/**
 * Subscribe to the "you have a new user app" hint dot for the Apps
 * top-bar entry. Returns true while at least one user app exists that
 * the user hasn't acknowledged.
 */
export function useNewUserAppsHint(): { active: boolean; dismiss: () => void } {
  const active = useSyncExternalStore(
    subscribe,
    getHintSnapshot,
    getServerSnapshot,
  );
  return { active, dismiss: markAllUserAppsSeen };
}
