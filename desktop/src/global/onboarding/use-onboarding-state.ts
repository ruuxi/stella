import { useCallback, useSyncExternalStore } from "react";
import { SPLIT_STEP_ORDER, type Phase } from "./onboarding-flow";
import {
  clearPostOnboardingHints,
  seedPostOnboardingHints,
} from "./post-onboarding-hints";

const ONBOARDING_COMPLETE_KEY = "stella-onboarding-complete";
/**
 * Persists the current onboarding phase so a user who quits the app
 * mid-flow lands back on the same step instead of the very first
 * "Start Stella" screen. Cleared on completion and on hard reset.
 * Only split-flow phases are persisted (intro is the entry surface
 * itself, and `complete`/`done` mean we're already past onboarding).
 */
const ONBOARDING_PHASE_KEY = "stella-onboarding-phase";
const ONBOARDING_COMPLETE_EVENT = "stella:onboarding-complete-changed";

const readOnboardingCompleted = () => {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true";
  } catch {
    return false;
  }
};

const SPLIT_PHASE_SET = new Set<Phase>(SPLIT_STEP_ORDER);

export const readOnboardingPhase = (): Phase | null => {
  try {
    const raw = localStorage.getItem(ONBOARDING_PHASE_KEY);
    if (!raw) return null;
    if (!SPLIT_PHASE_SET.has(raw as Phase)) {
      localStorage.removeItem(ONBOARDING_PHASE_KEY);
      return null;
    }
    return raw as Phase;
  } catch {
    return null;
  }
};

const writeOnboardingPhase = (phase: Phase | null) => {
  try {
    if (!phase || !SPLIT_PHASE_SET.has(phase)) {
      localStorage.removeItem(ONBOARDING_PHASE_KEY);
      return;
    }
    localStorage.setItem(ONBOARDING_PHASE_KEY, phase);
  } catch {
    // Best-effort; persistence is purely a UX nicety.
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
    writeOnboardingPhase(null);
    // Seed the one-time post-onboarding sidebar hints (Connect / Store).
    // Idempotent — re-completing onboarding without a reset is a no-op.
    seedPostOnboardingHints();
    window.dispatchEvent(new Event(ONBOARDING_COMPLETE_EVENT));
    notifyAll();
  }, []);

  const reset = useCallback(() => {
    localStorage.removeItem(ONBOARDING_COMPLETE_KEY);
    writeOnboardingPhase(null);
    // Reset clears the seeded marker too so the next completion re-shows
    // the post-onboarding hints, matching brand-new-install behavior.
    clearPostOnboardingHints();
    window.dispatchEvent(new Event(ONBOARDING_COMPLETE_EVENT));
    notifyAll();
  }, []);

  const persistPhase = useCallback((phase: Phase | null) => {
    writeOnboardingPhase(phase);
  }, []);

  return { completed, complete, reset, persistPhase };
}
