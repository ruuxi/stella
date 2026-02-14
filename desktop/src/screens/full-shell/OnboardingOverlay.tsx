/**
 * Onboarding flow: Start → Auth → Intro (center) → split layout steps.
 */

import { useCallback, useRef, useState } from "react";
import { useConvexAuth, useAction } from "convex/react";
import { api } from "@/convex/api";
import {
  StellaAnimation,
  type StellaAnimationHandle,
} from "../../components/StellaAnimation";
import { OnboardingStep1, useOnboardingState } from "../../components/Onboarding";
import { InlineAuth } from "../../components/InlineAuth";

const CREATURE_INITIAL_SIZE = 0.22;

type DiscoveryCategory = "dev_environment" | "apps_system" | "messages_notes";

export type OnboardingOverlayProps = {
  onDiscoveryConfirm: (categories: DiscoveryCategory[]) => void;
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
    resetUserData()
      .then(() => window.location.reload())
      .catch(console.error);
  }, [resetOnboarding, resetUserData]);

  return {
    onboardingDone,
    onboardingExiting,
    completeOnboarding: handleCompleteOnboarding,
    isAuthenticated,
    isAuthLoading,
    hasExpanded,
    splitMode,
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
  isAuthLoading,
  splitMode,
  stellaAnimationRef,
  onboardingKey,
  triggerFlash,
  startBirthAnimation,
  completeOnboarding,
  onSignIn,
  handleEnterSplit,
  onDiscoveryConfirm,
  onDemoChange,
}: {
  hasExpanded: boolean;
  onboardingDone: boolean;
  onboardingExiting?: boolean;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  splitMode: boolean;
  stellaAnimationRef: React.RefObject<StellaAnimationHandle | null>;
  onboardingKey: number;
  triggerFlash: () => void;
  startBirthAnimation: () => void;
  completeOnboarding: () => void;
  onSignIn: () => void;
  handleEnterSplit: () => void;
  onDiscoveryConfirm: (categories: DiscoveryCategory[]) => void;
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
          onDemoChange={onDemoChange}
          isAuthenticated={isAuthenticated}
        />
      )}
      {!isAuthenticated && onboardingDone && <InlineAuth className="onboarding-inline-auth--static" />}
    </div>
  );
}
