import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  PHASES,
  DISCOVERY_CATEGORIES_KEY,
  DISCOVERY_CATEGORIES,
  type Phase,
  type DiscoveryCategory,
  type OnboardingStep1Props,
} from "./use-onboarding-state";
import { OnboardingDiscovery } from "./OnboardingDiscovery";
import { InlineAuth } from "../InlineAuth";
import "../Onboarding.css";

const FADE_OUT_MS = 400;
const FADE_GAP_MS = 200;

export const OnboardingStep1: React.FC<OnboardingStep1Props> = ({
  onComplete,
  onAccept,
  onInteract,
  onOpenThemePicker,
  onConfirmTheme,
  onDiscoveryConfirm,
  themeConfirmed,
  hasSelectedTheme,
  isAuthenticated,
}) => {
  const [phase, setPhase] = useState<Phase>("start");
  const [leaving, setLeaving] = useState(false);
  const [rippleActive, setRippleActive] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [categoryStates, setCategoryStates] = useState<Record<DiscoveryCategory, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const cat of DISCOVERY_CATEGORIES) {
      initial[cat.id] = cat.defaultEnabled;
    }
    return initial as Record<DiscoveryCategory, boolean>;
  });

  const clearTimeoutRef = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Fade out current phase, then transition to next
  const transitionTo = useCallback((next: Phase) => {
    setLeaving(true);
    timeoutRef.current = setTimeout(() => {
      setLeaving(false);
      setPhase(next);
    }, FADE_OUT_MS + FADE_GAP_MS);
  }, []);

  const handleStart = () => {
    onAccept?.(); // triggers birth/grow animation
    onInteract?.();
    // Let the birth animation play, then fade out start and move to auth
    timeoutRef.current = setTimeout(() => {
      transitionTo(isAuthenticated ? "ripple-reveal" : "auth");
    }, 1600);
  };

  // Auto-advance from auth when user signs in
  useEffect(() => {
    if (isAuthenticated && phase === "auth" && !leaving) {
      onInteract?.();
      transitionTo("ripple-reveal");
    }
  }, [isAuthenticated, phase, leaving, onInteract, transitionTo]);

  // Ripple reveal: trigger the fade-in animations
  useEffect(() => {
    if (phase !== "ripple-reveal") return;

    const startTimer = setTimeout(() => {
      setRippleActive(true);
    }, 400);

    return () => {
      clearTimeout(startTimer);
    };
  }, [phase]);

  const handleRippleContinue = () => {
    onInteract?.();
    transitionTo("theme");
  };

  // Auto-advance from theme when confirmed
  useEffect(() => {
    if (themeConfirmed && phase === "theme" && !leaving) {
      onInteract?.();
      transitionTo("trust");
    }
  }, [themeConfirmed, phase, leaving, onInteract, transitionTo]);

  // Complete transition
  useEffect(() => {
    clearTimeoutRef();
    const config = PHASES[phase];

    if (config.kind === "complete") {
      timeoutRef.current = setTimeout(() => {
        setPhase("done");
        onComplete();
      }, 600);
      return clearTimeoutRef;
    }

    return clearTimeoutRef;
  }, [phase, onComplete, clearTimeoutRef]);

  const handleOpenThemePicker = () => {
    onInteract?.();
    onOpenThemePicker?.();
  };

  const handleConfirmTheme = () => {
    onInteract?.();
    onConfirmTheme?.();
  };

  const handleDiscoveryConfirm = () => {
    onInteract?.();
    const selected = (Object.entries(categoryStates) as [DiscoveryCategory, boolean][])
      .filter(([, enabled]) => enabled)
      .map(([id]) => id);
    localStorage.setItem(DISCOVERY_CATEGORIES_KEY, JSON.stringify(selected));
    onDiscoveryConfirm?.(selected);
    transitionTo("complete");
  };

  const handleToggleCategory = (id: DiscoveryCategory) => {
    setCategoryStates((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  if (phase === "done") return null;

  const showStart = phase === "start";
  const showAuth = phase === "auth";
  const showRipple = phase === "ripple-reveal";
  const showTheme = phase === "theme";
  const showTrust = phase === "trust";
  const isComplete = phase === "complete";

  return (
    <div
      className="onboarding-dialogue"
      data-phase={phase}
      data-leaving={leaving}
      style={{ display: isComplete ? "none" : "flex" }}
    >
      {/* Start — triggers birth animation */}
      {showStart && (
        <div className="onboarding-moment onboarding-moment--start">
          <button className="onboarding-start-button" onClick={handleStart}>
            Start Stella
          </button>
        </div>
      )}

      {/* Auth */}
      {showAuth && (
        <div className="onboarding-moment onboarding-moment--auth">
          <div className="onboarding-text">
            Sign in to begin
          </div>
          <InlineAuth />
        </div>
      )}

      {/* Ripple reveal */}
      {showRipple && (
        <div className="onboarding-moment onboarding-moment--ripple" data-active={rippleActive}>
          <div className="onboarding-ripple-content">
            <div className="onboarding-text onboarding-text--fade-in">
              Stella is an AI that runs on your computer.
            </div>
            <div className="onboarding-text onboarding-text--fade-in-delayed">
              She's not made for everyone. She's made for you.
            </div>
          </div>
          <div className="onboarding-choices onboarding-choices--subtle" data-visible={rippleActive}>
            <button className="onboarding-choice" onClick={handleRippleContinue}>
              Continue
            </button>
          </div>
        </div>
      )}

      {/* Theme */}
      {showTheme && (
        <div className="onboarding-moment onboarding-moment--theme">
          <div className="onboarding-text">
            How should I look?
          </div>
          <div className="onboarding-theme-actions">
            <button className="onboarding-choice" onClick={handleOpenThemePicker}>
              Browse Themes
            </button>
            {hasSelectedTheme && (
              <button className="onboarding-confirm" data-visible={true} onClick={handleConfirmTheme}>
                Confirm
              </button>
            )}
          </div>
        </div>
      )}

      {/* Trust */}
      {showTrust && (
        <div className="onboarding-moment onboarding-moment--trust">
          <div className="onboarding-text">
            How well should I know you?
          </div>
          <OnboardingDiscovery
            categoryStates={categoryStates}
            onToggleCategory={handleToggleCategory}
            onConfirm={handleDiscoveryConfirm}
          />
        </div>
      )}
    </div>
  );
};
