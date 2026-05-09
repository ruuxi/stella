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
import {
  readOnboardingPhase,
  useOnboardingState,
} from "@/global/onboarding/use-onboarding-state";
import { SPLIT_PHASES, type Phase } from "@/global/onboarding/onboarding-flow";
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
    persistPhase,
  } = useOnboardingState();
  const { hasConnectedAccount, isLoading: isAuthLoading } =
    useAuthSessionState();
  const resetUserData = useAction(api.reset.resetAllUserData);
  // Resolve the resume target ONCE at mount: if the user quit mid-flow we
  // skip the start screen and drop them back where they were. After that
  // first read the value is stable for the lifetime of this overlay
  // instance — `onboardingKey` bumps on reset to remount and re-resolve.
  const resumePhaseRef = useRef<Phase | null>(null);
  if (resumePhaseRef.current === null && !onboardingDone) {
    resumePhaseRef.current = readOnboardingPhase();
  }
  const resumePhase = onboardingDone ? null : resumePhaseRef.current;
  const isResuming = resumePhase !== null;
  const initialPhase: Phase = resumePhase ?? "intro";
  const creatureInitialBirth =
    onboardingDone || isResuming ? 1 : CREATURE_INITIAL_SIZE;
  const [hasExpanded, setHasExpanded] = useState(
    () => onboardingDone || isResuming,
  );
  const [hasStarted, setHasStarted] = useState(
    () => onboardingDone || isResuming,
  );
  const [splitMode, setSplitMode] = useState(
    () => isResuming && SPLIT_PHASES.has(initialPhase),
  );
  // True only during the brief "fade out + snap to split position" entry.
  // After ~350ms the entry settles and we restore animated transitions for
  // transform/width/height so subsequent shifts (e.g. discovery selections
  // moving Stella up, or returning to the parked position afterwards) glide
  // instead of jumping. Resumed sessions skip the entry entirely since the
  // creature was never in its centered start pose.
  const [splitEntering, setSplitEntering] = useState(false);
  const splitEnterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasDiscoverySelections, setHasDiscoverySelections] = useState(false);
  const [onboardingExiting, setOnboardingExiting] = useState(false);
  const [onboardingKey, setOnboardingKey] = useState(0);
  const stellaAnimationRef = useRef<StellaAnimationHandle | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowType = useWindowType();

  // While onboarding is active, expand the main window to cover the current
  // display. Trigger the restore at the START of the exit phase
  // (`onboardingExiting` flips true ~600ms before `onboardingDone`) so the
  // animated window resize finishes with the onboarding handoff instead of
  // snapping once onboarding completes.
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
    setSplitEntering(true);
    if (splitEnterTimerRef.current) {
      clearTimeout(splitEnterTimerRef.current);
    }
    splitEnterTimerRef.current = setTimeout(() => {
      setSplitEntering(false);
      splitEnterTimerRef.current = null;
    }, 400);
  }, []);

  useEffect(
    () => () => {
      if (splitEnterTimerRef.current) {
        clearTimeout(splitEnterTimerRef.current);
        splitEnterTimerRef.current = null;
      }
    },
    [],
  );

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
    resumePhaseRef.current = null;
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
    splitEntering,
    hasDiscoverySelections,
    setHasDiscoverySelections,
    onboardingKey,
    initialPhase,
    creatureInitialBirth,
    persistPhase,
    stellaAnimationRef,
    triggerFlash,
    startOnboarding,
    handleEnterSplit,
    handleResetOnboarding,
  };
}
