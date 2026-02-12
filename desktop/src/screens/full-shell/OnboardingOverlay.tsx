/**
 * Onboarding flow: Start → Auth → Intro (center) → split layout steps.
 */

import { useCallback, useRef, useState } from "react";
import { useConvexAuth } from "convex/react";
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

  const [hasExpanded, setHasExpanded] = useState(() => onboardingDone);
  const [splitMode, setSplitMode] = useState(false);
  const [onboardingKey, setOnboardingKey] = useState(0);
  const stellaAnimationRef = useRef<StellaAnimationHandle | null>(null);

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

  const handleResetOnboarding = useCallback(() => {
    setHasExpanded(false);
    setSplitMode(false);
    setOnboardingKey((k) => k + 1);
    stellaAnimationRef.current?.reset(CREATURE_INITIAL_SIZE);
    resetOnboarding();
  }, [resetOnboarding]);

  return {
    onboardingDone,
    completeOnboarding,
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
}: {
  hasExpanded: boolean;
  onboardingDone: boolean;
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
}) {
  return (
    <div className="new-session-view" data-split={splitMode}>
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
          isAuthenticated={isAuthenticated}
        />
      )}
      {!isAuthenticated && onboardingDone && <InlineAuth className="onboarding-inline-auth--static" />}
    </div>
  );
}
