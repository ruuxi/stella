import { useCallback, useSyncExternalStore } from "react";

export const ONBOARDING_COMPLETE_KEY = "stella-onboarding-complete";
const ONBOARDING_COMPLETE_EVENT = "stella:onboarding-complete-changed";

const readOnboardingCompleted = () => {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true";
  } catch {
    return false;
  }
};

/**
 * Module-level subscription so multiple consumers (`FullShell`, the
 * onboarding overlay hook, anything else) share a single pair of
 * `storage`/custom-event listeners on `window`. Previously each call
 * site registered its own pair, racing two independent boolean copies
 * for the same flag.
 */
const subscribers = new Set<() => void>();
let listenersAttached = false;

const handleStorageEvent = (event: StorageEvent) => {
  if (event.storageArea !== localStorage) return;
  if (event.key !== ONBOARDING_COMPLETE_KEY) return;
  for (const notify of subscribers) notify();
};

const handleCustomEvent = () => {
  for (const notify of subscribers) notify();
};

const attachWindowListeners = () => {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  window.addEventListener("storage", handleStorageEvent);
  window.addEventListener(ONBOARDING_COMPLETE_EVENT, handleCustomEvent);
};

const detachWindowListeners = () => {
  if (!listenersAttached || typeof window === "undefined") return;
  if (subscribers.size > 0) return;
  listenersAttached = false;
  window.removeEventListener("storage", handleStorageEvent);
  window.removeEventListener(ONBOARDING_COMPLETE_EVENT, handleCustomEvent);
};

const subscribe = (notify: () => void) => {
  subscribers.add(notify);
  attachWindowListeners();
  return () => {
    subscribers.delete(notify);
    detachWindowListeners();
  };
};

const getSnapshot = readOnboardingCompleted;
const getServerSnapshot = () => false;

const notifyAll = () => {
  for (const notify of subscribers) notify();
};

export function useOnboardingState() {
  const completed = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const complete = useCallback(() => {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
    window.dispatchEvent(new Event(ONBOARDING_COMPLETE_EVENT));
    notifyAll();
  }, []);

  const reset = useCallback(() => {
    localStorage.removeItem(ONBOARDING_COMPLETE_KEY);
    window.dispatchEvent(new Event(ONBOARDING_COMPLETE_EVENT));
    notifyAll();
  }, []);

  return { completed, complete, reset };
}
