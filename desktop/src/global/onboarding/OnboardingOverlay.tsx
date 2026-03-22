/**
 * Onboarding flow: Start -> Auth -> Intro (center) -> split layout steps.
 */

import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/api";
import { clearCachedToken } from "@/global/auth/services/auth-token";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { OnboardingStep1 } from "@/global/onboarding/OnboardingStep1";
import {
  StellaAnimation,
  type StellaAnimationHandle,
} from "@/shell/ascii-creature/StellaAnimation";
import { useOnboardingState } from "@/global/onboarding/use-onboarding-state";
import type { DiscoveryCategory } from "@/shared/contracts/discovery";
import type { OnboardingDemo } from "@/global/onboarding/OnboardingCanvas";
import type { LegalDocument } from "@/global/legal/legal-text";

const LegalDialog = lazy(() =>
  import("@/global/legal/LegalDialog").then((m) => ({ default: m.LegalDialog })),
);

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
  const {
    hasConnectedAccount,
    isLoading: isAuthLoading,
  } = useAuthSessionState();
  const resetUserData = useAction(api.reset.resetAllUserData);
  const [hasExpanded, setHasExpanded] = useState(() => onboardingDone);
  const [hasStarted, setHasStarted] = useState(() => onboardingDone);
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

  const startOnboarding = useCallback(() => {
    setHasStarted(true);
    setHasExpanded(true);
    stellaAnimationRef.current?.startBirth();
  }, []);

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
  isAuthLoading,
  isPreparingRuntime = false,
  runtimeError = null,
  splitMode,
  hasDiscoverySelections,
  hasStarted,
  stellaAnimationRef,
  onboardingKey,
  triggerFlash,
  startBirthAnimation,
  startOnboarding,
  completeOnboarding,
  handleEnterSplit,
  onRetryRuntime,
  onDiscoveryConfirm,
  onSelectionChange,
  onDemoChange,
  activeDemo,
  demoMorphing,
}: {
  hasExpanded: boolean;
  onboardingDone: boolean;
  onboardingExiting?: boolean;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  isPreparingRuntime?: boolean;
  runtimeError?: string | null;
  splitMode: boolean;
  hasDiscoverySelections?: boolean;
  hasStarted: boolean;
  stellaAnimationRef: React.RefObject<StellaAnimationHandle | null>;
  onboardingKey: number;
  triggerFlash: () => void;
  startBirthAnimation?: () => void;
  startOnboarding: () => void;
  completeOnboarding: () => void;
  handleEnterSplit: () => void;
  onRetryRuntime?: () => void;
  onDiscoveryConfirm: (categories: DiscoveryCategory[]) => void;
  onSelectionChange?: (hasSelections: boolean) => void;
  onDemoChange?: (demo: "default" | "modern" | "dj-studio" | "weather-station" | "cozy-cat" | "pomodoro" | null) => void;
  activeDemo?: OnboardingDemo;
  demoMorphing?: boolean;
}) {
  const showRuntimeGate = isPreparingRuntime || Boolean(runtimeError)
  const [activeLegalDoc, setActiveLegalDoc] = useState<LegalDocument | null>(null);

  return (
    <div className="new-session-view" data-split={splitMode} data-exiting={onboardingExiting || undefined}>
      <Suspense fallback={null}>
        <LegalDialog
          document={activeLegalDoc}
          onOpenChange={(open) => { if (!open) setActiveLegalDoc(null); }}
        />
      </Suspense>
      <div
        className="new-session-title"
        data-expanded={hasExpanded ? "true" : "false"}
      >
        Stella
      </div>
      <div
        onClick={() => {
          if (hasExpanded) {
            triggerFlash()
            return
          }
          startBirthAnimation?.()
          triggerFlash()
        }}
        className="onboarding-stella-animation"
        data-expanded={hasExpanded ? "true" : "false"}
        data-split={splitMode}
        data-has-selections={hasDiscoverySelections || undefined}
        data-demo-active={activeDemo || undefined}
        title={hasExpanded ? undefined : "Click to awaken"}
      >
        <StellaAnimation
          ref={stellaAnimationRef}
          width={70}
          height={39}
          initialBirthProgress={onboardingDone ? 1 : CREATURE_INITIAL_SIZE}
        />
      </div>
      {(showRuntimeGate || !onboardingDone) &&
        (isPreparingRuntime || isAuthLoading ? (
          <div className="onboarding-moment onboarding-moment--auth">
            <div className="onboarding-text">Preparing Stella...</div>
          </div>
        ) : runtimeError ? (
          <div className="onboarding-moment onboarding-moment--start">
            <button
              className="onboarding-start-button"
              onClick={() => {
                onRetryRuntime?.()
              }}
            >
              Retry Stella Startup
            </button>
          </div>
        ) : hasStarted ? (
          <OnboardingStep1
            key={onboardingKey}
            initialPhase="intro"
            onComplete={completeOnboarding}
            onInteract={triggerFlash}
            onDiscoveryConfirm={onDiscoveryConfirm}
            onEnterSplit={handleEnterSplit}
            onSelectionChange={onSelectionChange}
            onDemoChange={onDemoChange}
            demoMorphing={demoMorphing}
            isAuthenticated={isAuthenticated}
          />
        ) : (
          <div className="onboarding-moment onboarding-moment--start">
            <button
              className="onboarding-start-button"
              onClick={() => {
                startOnboarding();
                triggerFlash();
              }}
            >
              Start Stella
            </button>
            <div className="onboarding-legal-footer">
              By using Stella, you agree to our{" "}
              <button
                type="button"
                className="onboarding-legal-link"
                onClick={() => setActiveLegalDoc("terms")}
              >
                Terms of Service
              </button>{" "}
              and{" "}
              <button
                type="button"
                className="onboarding-legal-link"
                onClick={() => setActiveLegalDoc("privacy")}
              >
                Privacy Policy
              </button>
              .
            </div>
          </div>
        ))}
    </div>
  );
}
