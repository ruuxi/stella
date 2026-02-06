import React, { useState, useEffect, useRef, useCallback } from "react";
import "./Onboarding.css";

const ONBOARDING_KEY = "stella-onboarding-complete";

const TYPE_SPEED_MIN = 35;
const TYPE_SPEED_MAX = 75;

const getTypeDelay = () =>
  TYPE_SPEED_MIN + Math.random() * (TYPE_SPEED_MAX - TYPE_SPEED_MIN);

const PHASES = {
  "typing-intro": {
    kind: "typing",
    text: "Stella is an artificial intelligence assistant for humans.",
    startDelay: 600,
    next: "waiting-click",
  },
  "waiting-click": {
    kind: "click",
    prompt: "sign in to begin",
  },
  "fading-out": {
    kind: "fade",
    next: "typing-preview",
  },
  "typing-preview": {
    kind: "typing",
    text: "As an experimental research preview, Stella can make mistakes but learns, grows, and helps you along the way.",
    startDelay: 200,
    next: "waiting-click-preview",
  },
  "waiting-click-preview": {
    kind: "click",
    prompt: "click",
  },
  "fading-out-preview": {
    kind: "fade",
    next: "typing-question",
  },
  "typing-question": {
    kind: "typing",
    text: "Knowing this, will you bring her to life?",
    startDelay: 200,
    next: "waiting",
  },
  "waiting": {
    kind: "choices",
  },
  "fading-out-question": {
    kind: "fade",
    next: "delay-theme",
  },
  "delay-theme": {
    kind: "delay",
    delayMs: 3000,
    next: "typing-theme",
  },
  "typing-theme": {
    kind: "typing",
    text: "Select Theme",
    startDelay: 200,
    next: "waiting-theme",
  },
  "waiting-theme": {
    kind: "theme",
  },
  "fading-out-theme": {
    kind: "fade",
    next: "typing-discovery",
  },
  "typing-discovery": {
    kind: "typing",
    text: "What should Stella learn about you?",
    startDelay: 200,
    next: "waiting-discovery",
  },
  "waiting-discovery": {
    kind: "discovery",
  },
  "fading-out-discovery": {
    kind: "fade",
    next: "accepted",
  },
  "accepted": {
    kind: "accepted",
  },
  "declined": {
    kind: "declined",
  },
  "done": {
    kind: "done",
  },
} as const;

type Phase = keyof typeof PHASES;

const INTRO_PHASES = new Set<Phase>([
  "typing-intro",
  "waiting-click",
  "fading-out",
  "typing-preview",
  "waiting-click-preview",
  "fading-out-preview",
]);

export function useOnboardingState() {
  const [completed, setCompleted] = useState(() => {
    return localStorage.getItem(ONBOARDING_KEY) === "true";
  });

  const complete = useCallback(() => {
    localStorage.setItem(ONBOARDING_KEY, "true");
    setCompleted(true);
  }, []);

  const reset = useCallback(() => {
    localStorage.removeItem(ONBOARDING_KEY);
    setCompleted(false);
  }, []);

  return { completed, complete, reset };
}

type DiscoveryCategory = "browsing_bookmarks" | "dev_environment" | "apps_system" | "messages_notes";

const DISCOVERY_CATEGORIES: {
  id: DiscoveryCategory;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiresFDA: boolean;
}[] = [
  { id: "browsing_bookmarks", label: "Browsing & Bookmarks", description: "Browser history, bookmarks, and saved pages", defaultEnabled: true, requiresFDA: false },
  { id: "dev_environment", label: "Development Environment", description: "IDE extensions, git config, dotfiles, runtimes, and package managers", defaultEnabled: true, requiresFDA: false },
  { id: "apps_system", label: "Apps & System", description: "App usage patterns, dock pins, and filesystem signals", defaultEnabled: true, requiresFDA: true },
  { id: "messages_notes", label: "Messages & Notes", description: "Communication patterns, note titles, calendar density (metadata only)", defaultEnabled: false, requiresFDA: true },
];

const DISCOVERY_CATEGORIES_KEY = "stella-discovery-categories";

interface OnboardingStep1Props {
  onComplete: () => void;
  onAccept?: () => void;
  onInteract?: () => void;
  onSignIn?: () => void;
  onOpenThemePicker?: () => void;
  onConfirmTheme?: () => void;
  onDiscoveryConfirm?: (categories: DiscoveryCategory[]) => void;
  themeConfirmed?: boolean;
  hasSelectedTheme?: boolean;
  isAuthenticated?: boolean;
}

export const OnboardingStep1: React.FC<OnboardingStep1Props> = ({ onComplete, onAccept, onInteract, onSignIn, onOpenThemePicker, onConfirmTheme, onDiscoveryConfirm, themeConfirmed, hasSelectedTheme, isAuthenticated }) => {
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
    if (phase === "waiting-click") {
      // Open sign-in dialog instead of advancing directly
      onSignIn?.();
      return;
    } else if (phase === "waiting-click-preview") {
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

  const phaseConfig = PHASES[phase];
  const isIntro = INTRO_PHASES.has(phase);
  const clickPromptText = phaseConfig.kind === "click" ? phaseConfig.prompt : "";
  const showClickPrompt = Boolean(clickPromptText);
  const showChoices = phaseConfig.kind === "choices";
  const isDeclining = phaseConfig.kind === "declined";
  const showThemePicker = phaseConfig.kind === "theme";
  const showDiscovery = phaseConfig.kind === "discovery";
  const platform = window.electronAPI?.platform ?? "unknown";
  const hasFDACategories = DISCOVERY_CATEGORIES.some(
    (cat) => cat.requiresFDA && categoryStates[cat.id]
  );

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
          <div className="onboarding-discovery" data-visible={true}>
            {DISCOVERY_CATEGORIES.map((cat) => (
              <div key={cat.id} className="onboarding-discovery-card">
                <div className="onboarding-discovery-card-text">
                  <div className="onboarding-discovery-card-title">{cat.label}</div>
                  <div className="onboarding-discovery-card-desc">{cat.description}</div>
                  {cat.requiresFDA && platform === "darwin" && (
                    <div className="onboarding-discovery-fda">requires full disk access</div>
                  )}
                </div>
                <button
                  className="onboarding-discovery-toggle"
                  data-active={categoryStates[cat.id]}
                  onClick={() =>
                    setCategoryStates((prev) => ({
                      ...prev,
                      [cat.id]: !prev[cat.id],
                    }))
                  }
                >
                  <span className="onboarding-discovery-toggle-thumb" />
                </button>
              </div>
            ))}
            {hasFDACategories && platform === "darwin" && (
              <button
                className="onboarding-discovery-fda-button"
                onClick={() => window.electronAPI?.openFullDiskAccess?.()}
              >
                open system preferences
              </button>
            )}
            <button
              className="onboarding-confirm"
              data-visible={true}
              onClick={handleDiscoveryConfirm}
            >
              continue
            </button>
          </div>
        )}
      </div>
    </>
  );
};
