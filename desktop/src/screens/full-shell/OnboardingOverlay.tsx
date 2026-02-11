/**
 * Onboarding flow: creature animation, step1/step2, shown before first message.
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

type DiscoveryCategory =
  | "browsing_bookmarks"
  | "dev_environment"
  | "apps_system"
  | "messages_notes";

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
  const [onboardingKey, setOnboardingKey] = useState(0);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [themeConfirmed, setThemeConfirmed] = useState(false);
  const [hasSelectedTheme, setHasSelectedTheme] = useState(false);
  const stellaAnimationRef = useRef<StellaAnimationHandle | null>(null);

  const triggerFlash = useCallback(() => {
    stellaAnimationRef.current?.triggerFlash();
  }, []);

  const startBirthAnimation = useCallback(() => {
    if (hasExpanded) return;
    setHasExpanded(true);
    stellaAnimationRef.current?.startBirth();
  }, [hasExpanded]);

  const handleResetOnboarding = useCallback(() => {
    setHasExpanded(false);
    setOnboardingKey((k) => k + 1);
    setThemeConfirmed(false);
    setHasSelectedTheme(false);
    setThemePickerOpen(false);
    stellaAnimationRef.current?.reset(CREATURE_INITIAL_SIZE);
    resetOnboarding();
  }, [resetOnboarding]);

  const handleOpenThemePicker = useCallback(() => {
    setThemePickerOpen(true);
  }, []);

  const handleConfirmTheme = useCallback(() => {
    setThemeConfirmed(true);
    setThemePickerOpen(false);
  }, []);

  const handleThemeSelect = useCallback(() => {
    setHasSelectedTheme(true);
  }, []);

  return {
    onboardingDone,
    completeOnboarding,
    isAuthenticated,
    isAuthLoading,
    hasExpanded,
    onboardingKey,
    themePickerOpen,
    setThemePickerOpen,
    themeConfirmed,
    hasSelectedTheme,
    stellaAnimationRef,
    triggerFlash,
    startBirthAnimation,
    handleResetOnboarding,
    handleOpenThemePicker,
    handleConfirmTheme,
    handleThemeSelect,
  };
}

export function OnboardingView({
  hasExpanded,
  onboardingDone,
  isAuthenticated,
  isAuthLoading,
  stellaAnimationRef,
  onboardingKey,
  triggerFlash,
  startBirthAnimation,
  completeOnboarding,
  onSignIn,
  handleOpenThemePicker,
  handleConfirmTheme,
  themeConfirmed,
  hasSelectedTheme,
  onDiscoveryConfirm,
}: {
  hasExpanded: boolean;
  onboardingDone: boolean;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  stellaAnimationRef: React.RefObject<StellaAnimationHandle | null>;
  onboardingKey: number;
  triggerFlash: () => void;
  startBirthAnimation: () => void;
  completeOnboarding: () => void;
  onSignIn: () => void;
  handleOpenThemePicker: () => void;
  handleConfirmTheme: () => void;
  themeConfirmed: boolean;
  hasSelectedTheme: boolean;
  onDiscoveryConfirm: (categories: DiscoveryCategory[]) => void;
}) {
  return (
    <div className="new-session-view">
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
          onSignIn={onSignIn}
          onOpenThemePicker={handleOpenThemePicker}
          onConfirmTheme={handleConfirmTheme}
          onDiscoveryConfirm={onDiscoveryConfirm}
          themeConfirmed={themeConfirmed}
          hasSelectedTheme={hasSelectedTheme}
          isAuthenticated={isAuthenticated}
        />
      )}
      {!isAuthenticated && onboardingDone && <InlineAuth className="onboarding-inline-auth--static" />}
    </div>
  );
}
