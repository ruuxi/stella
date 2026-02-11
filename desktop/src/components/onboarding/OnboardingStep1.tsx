import React, { useState, useEffect, useRef } from "react";
import {
  PHASES,
  INTRO_PHASES,
  DISCOVERY_CATEGORIES_KEY,
  DISCOVERY_CATEGORIES,
  getTypeDelay,
  type Phase,
  type DiscoveryCategory,
  type OnboardingStep1Props,
} from "./use-onboarding-state";
import { OnboardingDiscovery } from "./OnboardingDiscovery";
import { InlineAuth } from "../InlineAuth";
import "../Onboarding.css";

export const OnboardingStep1: React.FC<OnboardingStep1Props> = ({ onComplete, onAccept, onInteract, onOpenThemePicker, onConfirmTheme, onDiscoveryConfirm, themeConfirmed, hasSelectedTheme, isAuthenticated }) => {
  const [phase, setPhase] = useState<Phase>("typing-intro");
  const [displayed, setDisplayed] = useState("");
  const [showCursor, setShowCursor] = useState(true);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Discovery category toggles
  const [categoryStates, setCategoryStates] = useState<Record<DiscoveryCategory, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const cat of DISCOVERY_CATEGORIES) {
      initial[cat.id] = cat.defaultEnabled;
    }
    return initial as Record<DiscoveryCategory, boolean>;
  });

  const clearTimeoutRef = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const schedule = (fn: () => void, ms: number) => {
    timeoutRef.current = setTimeout(fn, ms);
  };

  useEffect(() => {
    clearTimeoutRef();

    const config = PHASES[phase];
    if (config.kind === "typing") {
      setShowCursor(true);
      setDisplayed("");
      let i = 0;
      const type = () => {
        if (i < config.text.length) {
          i++;
          setDisplayed(config.text.slice(0, i));
          schedule(type, getTypeDelay());
        } else {
          schedule(() => {
            setShowCursor(false);
            setPhase(config.next);
          }, 400);
        }
      };
      schedule(type, config.startDelay);
      return clearTimeoutRef;
    }

    if (config.kind === "fade") {
      // Wait for fade animation (0.4s) + pause (0.2s) = 0.6s total
      schedule(() => {
        setDisplayed("");
        setPhase(config.next);
      }, 600);
      return clearTimeoutRef;
    }

    if (config.kind === "delay") {
      schedule(() => {
        setPhase(config.next);
      }, config.delayMs);
      return clearTimeoutRef;
    }

    if (config.kind === "declined") {
      schedule(() => {
        setDisplayed("");
        setShowCursor(true);
        setPhase("typing-question");
      }, 2500);
      return clearTimeoutRef;
    }

    if (config.kind === "accepted") {
      // Wait for black hole animation, then complete onboarding
      schedule(() => {
        setPhase("done");
        onComplete();
      }, 3000);
    }

    return clearTimeoutRef;
  }, [phase, onComplete]);

  // Auto-advance from waiting-click when user signs in
  useEffect(() => {
    if (isAuthenticated && phase === "waiting-click") {
      onInteract?.();
      setPhase("fading-out");
    }
  }, [isAuthenticated, phase, onInteract]);

  // Auto-advance from waiting-theme when theme is confirmed
  useEffect(() => {
    if (themeConfirmed && phase === "waiting-theme") {
      onInteract?.();
      setPhase("fading-out-theme");
    }
  }, [themeConfirmed, phase, onInteract]);

  const handleClick = () => {
    onInteract?.();
    if (phase === "waiting-click-preview") {
      setPhase("fading-out-preview");
    }
  };

  const handleYes = () => {
    onInteract?.();
    setPhase("fading-out-question");
    onAccept?.();
  };

  const handleNo = () => {
    onInteract?.();
    setPhase("declined");
  };

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
    setPhase("fading-out-discovery");
  };

  const handleToggleCategory = (id: DiscoveryCategory) => {
    setCategoryStates((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const phaseConfig = PHASES[phase];
  const isIntro = INTRO_PHASES.has(phase);
  const showInlineAuth = phase === "waiting-click";
  const clickPromptText = phaseConfig.kind === "click" && phase !== "waiting-click" ? phaseConfig.prompt : "";
  const showClickPrompt = Boolean(clickPromptText);
  const showChoices = phaseConfig.kind === "choices";
  const isDeclining = phaseConfig.kind === "declined";
  const showThemePicker = phaseConfig.kind === "theme";
  const showDiscovery = phaseConfig.kind === "discovery";

  if (phase === "done") return null;

  return (
    <>
      {showClickPrompt && (
        <div
          className="onboarding-click-overlay"
          onClick={handleClick}
        />
      )}
      <div
        className="onboarding-dialogue"
        data-declined={isDeclining}
        data-phase={phase}
        style={{ display: phase === "accepted" ? "none" : "flex" }}
      >
        <div
          className="onboarding-text"
          data-intro={isIntro}
        >
          {displayed}
          <span className="onboarding-cursor" style={{ opacity: showCursor ? 1 : 0 }}>│</span>
        </div>

        {showInlineAuth && <InlineAuth />}

        {showClickPrompt && (
          <div className="onboarding-choices onboarding-choices--subtle" data-visible={true}>
            <span className="onboarding-choice">
              {clickPromptText}
            </span>
          </div>
        )}

        <div className="onboarding-choices" data-visible={showChoices}>
          <button className="onboarding-choice" onClick={handleYes}>
            yes
          </button>
          <button className="onboarding-choice" onClick={handleNo}>
            no
          </button>
        </div>

        {showThemePicker && (
          <div className="onboarding-choices onboarding-choices--theme" data-visible={true}>
            <button className="onboarding-choice" onClick={handleOpenThemePicker}>
              choose
            </button>
            <button className="onboarding-confirm" data-visible={hasSelectedTheme} onClick={handleConfirmTheme}>
              confirm
            </button>
          </div>
        )}

        {showDiscovery && (
          <OnboardingDiscovery
            categoryStates={categoryStates}
            onToggleCategory={handleToggleCategory}
            onConfirm={handleDiscoveryConfirm}
          />
        )}
      </div>
    </>
  );
};
