/**
 * Hook half of the onboarding overlay module.
 *
 * Lives in its own file so it can be statically imported by FullShell
 * without pulling the heavy view tree (StellaAnimation, all phase
 * components, mock windows, capabilities scenes, legal dialog) into the
 * main bundle. The view tree lives in OnboardingOverlay.tsx and is
 * loaded lazily as the "onboarding chunk".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/api";
import { clearCachedToken } from "@/global/auth/services/auth-token";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { useOnboardingState } from "@/global/onboarding/use-onboarding-state";
import { useWindowType } from "@/shared/hooks/use-window-type";
import type { StellaAnimationHandle } from "@/shell/ascii-creature/StellaAnimation";

export const CREATURE_INITIAL_SIZE = 0.22;

const deleteIndexedDatabase = (name: string) =>
  new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });

const clearLocalBrowserState = async () => {
  clearCachedToken();

  try {
    localStorage.clear();
  } catch {
    /* best-effort browser state cleanup */
  }

  try {
    sessionStorage.clear();
  } catch {
    /* best-effort browser state cleanup */
  }

  if (
    typeof indexedDB !== "undefined" &&
    typeof indexedDB.databases === "function"
  ) {
    try {
      const databases = await indexedDB.databases();
      const names = databases
        .map((database) => database.name)
        .filter(
          (name): name is string => typeof name === "string" && name.length > 0,
        );
      await Promise.all(names.map(deleteIndexedDatabase));
    } catch {
      /* best-effort browser state cleanup */
    }
  }

  if (typeof caches !== "undefined") {
    try {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.map((cacheName) => caches.delete(cacheName)),
      );
    } catch {
      /* best-effort browser state cleanup */
    }
  }
};

const clearLocalRuntimeState = async () => {
  await clearLocalBrowserState();
  await window.electronAPI?.ui.hardReset?.();
};

export function useOnboardingOverlay() {
  const {
    completed: onboardingDone,
    complete: completeOnboarding,
    reset: resetOnboarding,
  } = useOnboardingState();
  const { hasConnectedAccount, isLoading: isAuthLoading } =
    useAuthSessionState();
  const resetUserData = useAction(api.reset.resetAllUserData);
  const [hasExpanded, setHasExpanded] = useState(() => onboardingDone);
  const [hasStarted, setHasStarted] = useState(() => onboardingDone);
  const [splitMode, setSplitMode] = useState(false);
  const [hasDiscoverySelections, setHasDiscoverySelections] = useState(false);
  const [onboardingExiting, setOnboardingExiting] = useState(false);
  const [onboardingKey, setOnboardingKey] = useState(0);
  const stellaAnimationRef = useRef<StellaAnimationHandle | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowType = useWindowType();

  // While onboarding is active, expand the (transparent) main window to cover
  // the current display so the renderer's radial fog mask fades to full
  // transparency well inside the window bounds — no perceivable rectangle.
  // Trigger the restore at the START of the exit phase (`onboardingExiting`
  // flips true ~600ms before `onboardingDone`) so the animated window resize
  // runs concurrently with the fog fade-out, giving a single coordinated
  // transition rather than a snap once onboarding completes.
  //
  // Onboarding only ever runs in the full window — the mini and overlay
  // renderers also mount `FullShell` and would otherwise drive this IPC,
  // which is sized for the full window (DEFAULT_WIDTH/HEIGHT 1400×940). On
  // the mini it animates a resize toward the work-area centre clamped by
  // the mini's maxWidth/maxHeight, which manifests as the panel visibly
  // growing/sliding from its summon location after first show.
  useEffect(() => {
    if (windowType !== "full") return;
    const setPresentation = window.electronAPI?.ui.setOnboardingPresentation;
    if (typeof setPresentation !== "function") return;
    const fullscreen = !(onboardingDone || onboardingExiting);
    void setPresentation(fullscreen);
  }, [onboardingDone, onboardingExiting, windowType]);

  const triggerFlash = useCallback(() => {
    stellaAnimationRef.current?.triggerFlash();
  }, []);

  const startOnboarding = useCallback(() => {
    setHasStarted(true);
    setHasExpanded(true);
    stellaAnimationRef.current?.startBirth();
  }, []);

  const handleEnterSplit = useCallback(() => {
    setSplitMode(true);
  }, []);

  const handleCompleteOnboarding = useCallback(() => {
    if (exitTimerRef.current) return;

    setOnboardingExiting(true);
    exitTimerRef.current = setTimeout(() => {
      setSplitMode(false);
      completeOnboarding();
      setOnboardingExiting(false);
      exitTimerRef.current = null;
    }, 600);
  }, [completeOnboarding]);

  const handleResetOnboarding = useCallback(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setHasExpanded(false);
    setHasStarted(false);
    setSplitMode(false);
    setOnboardingExiting(false);
    setOnboardingKey((k) => k + 1);
    stellaAnimationRef.current?.reset(CREATURE_INITIAL_SIZE);
    resetOnboarding();

    const finishLocalReset = async () => {
      try {
        await clearLocalRuntimeState();
      } catch (error) {
        console.error(error);
      }
      window.location.reload();
    };

    if (!hasConnectedAccount) {
      void finishLocalReset();
      return;
    }

    resetUserData()
      .catch(console.error)
      .finally(() => {
        void finishLocalReset();
      });
  }, [hasConnectedAccount, resetOnboarding, resetUserData]);

  return {
    onboardingDone,
    onboardingExiting,
    completeOnboarding: handleCompleteOnboarding,
    isAuthenticated: hasConnectedAccount,
    isAuthLoading,
    hasExpanded,
    hasStarted,
    splitMode,
    hasDiscoverySelections,
    setHasDiscoverySelections,
    onboardingKey,
    stellaAnimationRef,
    triggerFlash,
    startOnboarding,
    handleEnterSplit,
    handleResetOnboarding,
  };
}
