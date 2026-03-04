/**
 * Onboarding flow: Start -> Auth -> Intro (center) -> split layout steps.
 */

import { useCallback, useRef, useState } from "react";
import { useConvexAuth, useAction } from "convex/react";
import { api } from "@/convex/api";
import { clearCachedToken } from "@/services/auth-token";
import {
  StellaAnimation,
  type StellaAnimationHandle,
} from "@/app/shell/ascii-creature/StellaAnimation";
import { OnboardingStep1, useOnboardingState } from "@/app/onboarding/Onboarding";
import type { DiscoveryCategory } from "@/app/onboarding/use-onboarding-state";

const CREATURE_INITIAL_SIZE = 0.22;

export type OnboardingOverlayProps = {
  onDiscoveryConfirm: (categories: DiscoveryCategory[]) => void;
};

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
  } catch { /* best-effort browser state cleanup */ }

  try {
    sessionStorage.clear();
  } catch { /* best-effort browser state cleanup */ }

  if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
    try {
      const databases = await indexedDB.databases();
      const names = databases
        .map((database) => database.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0);
      await Promise.all(names.map(deleteIndexedDatabase));
    } catch { /* best-effort browser state cleanup */ }
  }

  if (typeof caches !== "undefined") {
    try {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
    } catch { /* best-effort browser state cleanup */ }
  }
};

const clearLocalRuntimeState = async () => {
  await clearLocalBrowserState();
  await window.electronAPI?.ui.hardReset?.();
};

// eslint-disable-next-line react-refresh/only-export-components
export function useOnboardingOverlay() {
  const {
    completed: onboardingDone,
    complete: completeOnboarding,
    reset: resetOnboarding,
  } = useOnboardingState();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const resetUserData = useAction(api.reset.resetAllUserData);

  const [hasExpanded, setHasExpanded] = useState(() => onboardingDone);
  const [splitMode, setSplitMode] = useState(false);
  const [hasDiscoverySelections, setHasDiscoverySelections] = useState(false);
  const [onboardingExiting, setOnboardingExiting] = useState(false);
  const [onboardingKey, setOnboardingKey] = useState(0);
  const stellaAnimationRef = useRef<StellaAnimationHandle | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerFlash = useCallback(() => {
    stellaAnimationRef.current?.triggerFlash();
  }, []);

  const startBirthAnimation = useCallback(() => {
    if (hasExpanded) return;
    setHasExpanded(true);
    stellaAnimationRef.current?.startBirth();
  }, [hasExpanded]);

  const handleEnterSplit = useCallback(() => {
    setSplitMode(true);
  }, []);

  const handleCompleteOnboarding = useCallback(() => {
    setSplitMode(false);
    setOnboardingExiting(true);
    exitTimerRef.current = setTimeout(() => {
      completeOnboarding();
      setTimeout(() => setOnboardingExiting(false), 400);
    }, 800);
  }, [completeOnboarding]);

  const handleResetOnboarding = useCallback(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setHasExpanded(false);
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

    if (!isAuthenticated) {
      void finishLocalReset();
      return;
    }

    resetUserData()
      .catch(console.error)
      .finally(() => {
        void finishLocalReset();
      });
  }, [isAuthenticated, resetOnboarding, resetUserData]);

  return {
    onboardingDone,
    onboardingExiting,
    completeOnboarding: handleCompleteOnboarding,
    isAuthenticated,
    isAuthLoading,
    hasExpanded,
    splitMode,
    hasDiscoverySelections,
    setHasDiscoverySelections,
    onboardingKey,
    stellaAnimationRef,
    triggerFlash,
    startBirthAnimation,
    handleEnterSplit,
    handleResetOnboarding,
  };
}

export function OnboardingView({
  hasExpanded,
  onboardingDone,
  onboardingExiting,
  isAuthenticated,
  splitMode,
  hasDiscoverySelections,
  stellaAnimationRef,
  onboardingKey,
  triggerFlash,
  startBirthAnimation,
  completeOnboarding,
  handleEnterSplit,
  onDiscoveryConfirm,
  onSelectionChange,
  onDemoChange,
}: {
  hasExpanded: boolean;
  onboardingDone: boolean;
  onboardingExiting?: boolean;
  isAuthenticated: boolean;
  splitMode: boolean;
  hasDiscoverySelections?: boolean;
  stellaAnimationRef: React.RefObject<StellaAnimationHandle | null>;
  onboardingKey: number;
  triggerFlash: () => void;
  startBirthAnimation: () => void;
  completeOnboarding: () => void;
  handleEnterSplit: () => void;
  onDiscoveryConfirm: (categories: DiscoveryCategory[]) => void;
  onSelectionChange?: (hasSelections: boolean) => void;
  onDemoChange?: (demo: "dj-studio" | "weather-station" | null) => void;
}) {
  return (
    <div className="new-session-view" data-split={splitMode} data-exiting={onboardingExiting || undefined}>
      <div
        className="new-session-title"
        data-expanded={hasExpanded ? "true" : "false"}
      >
        Stella
      </div>
      <div
        onClick={() => {
          triggerFlash();
          if (!hasExpanded) {
            startBirthAnimation();
          }
        }}
        className="onboarding-stella-animation"
        data-expanded={hasExpanded ? "true" : "false"}
        data-split={splitMode}
        data-has-selections={hasDiscoverySelections || undefined}
        title={!hasExpanded ? "Click to awaken" : undefined}
      >
        <StellaAnimation
          ref={stellaAnimationRef}
          width={100}
          height={56}
          initialBirthProgress={onboardingDone ? 1 : CREATURE_INITIAL_SIZE}
        />
      </div>
      {!onboardingDone && (
        <OnboardingStep1
          key={onboardingKey}
          onComplete={completeOnboarding}
          onAccept={startBirthAnimation}
          onInteract={triggerFlash}
          onDiscoveryConfirm={onDiscoveryConfirm}
          onEnterSplit={handleEnterSplit}
          onSelectionChange={onSelectionChange}
          onDemoChange={onDemoChange}
          isAuthenticated={isAuthenticated}
        />
      )}
    </div>
  );
}


