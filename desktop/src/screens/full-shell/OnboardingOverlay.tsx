/**
 * Onboarding flow: creature animation, step1/step2, shown before first message.
 */

import { useCallback, useRef, useState } from "react";
import { useConvexAuth } from "convex/react";
import { Spinner } from "../../components/spinner";
import { Button } from "../../components/button";
import {
  AsciiBlackHole,
  type AsciiBlackHoleHandle,
} from "../../components/AsciiBlackHole";
import { OnboardingStep1, useOnboardingState } from "../../components/Onboarding";

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
  const blackHoleRef = useRef<AsciiBlackHoleHandle | null>(null);

  const triggerFlash = useCallback(() => {
    blackHoleRef.current?.triggerFlash();
  }, []);

  const startBirthAnimation = useCallback(() => {
    if (hasExpanded) return;
    setHasExpanded(true);
    blackHoleRef.current?.startBirth();
  }, [hasExpanded]);

  const handleResetOnboarding = useCallback(() => {
    setHasExpanded(false);
    setOnboardingKey((k) => k + 1);
    setThemeConfirmed(false);
    setHasSelectedTheme(false);
    setThemePickerOpen(false);
    blackHoleRef.current?.reset(CREATURE_INITIAL_SIZE);
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
    blackHoleRef,
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
  blackHoleRef,
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
  blackHoleRef: React.RefObject<AsciiBlackHoleHandle | null>;
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
        className="onboarding-blackhole"
        data-expanded={hasExpanded ? "true" : "false"}
        title={!hasExpanded ? "Click to awaken" : undefined}
      >
        <AsciiBlackHole
          ref={blackHoleRef}
          width={120}
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
      {!isAuthenticated && onboardingDone && (
        <Button
          variant="secondary"
          size="large"
          onClick={onSignIn}
          disabled={isAuthLoading}
          className="onboarding-signin"
        >
          {isAuthLoading ? <Spinner size="sm" /> : "Sign in"}
        </Button>
      )}
    </div>
  );
}
