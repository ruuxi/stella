import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  CENTER_PHASES,
  SPLIT_PHASES,
  SPLIT_STEP_ORDER,
  DISCOVERY_CATEGORIES_KEY,
  DISCOVERY_CATEGORIES,
  BROWSERS,
  type Phase,
  type DiscoveryCategory,
  type BrowserId,
  type OnboardingStep1Props,
} from "./use-onboarding-state";
import { OnboardingDiscovery } from "./OnboardingDiscovery";
import { InlineAuth } from "../InlineAuth";
import { useTheme } from "../../theme/theme-context";
import "../Onboarding.css";

const FADE_OUT_MS = 400;
const FADE_GAP_MS = 200;

/* ── Step title text (shown on left in split mode) ── */
const STEP_TITLES: Partial<Record<Phase, string>> = {
  browser: "I'll need a browser.",
  discovery: "How well should I know you?",
  memory: "I remember everything.",
  creation: "I can build things.",
  phone: "You can reach me anywhere.",
  theme: "How should I look?",
  personality: "How should I talk?",
};

export const OnboardingStep1: React.FC<OnboardingStep1Props> = ({
  onComplete,
  onAccept,
  onInteract,
  onDiscoveryConfirm,
  onEnterSplit,
  isAuthenticated,
}) => {
  const [phase, setPhase] = useState<Phase>("start");
  const [leaving, setLeaving] = useState(false);
  const [rippleActive, setRippleActive] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Browser selection
  const [selectedBrowser, setSelectedBrowser] = useState<BrowserId | null>(null);

  // Discovery category toggles
  const [categoryStates, setCategoryStates] = useState<Record<DiscoveryCategory, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const cat of DISCOVERY_CATEGORIES) {
      initial[cat.id] = cat.defaultEnabled;
    }
    return initial as Record<DiscoveryCategory, boolean>;
  });

  // Personality
  const [useEmojis, setUseEmojis] = useState<boolean | null>(null);

  // Theme (inline)
  const {
    themeId,
    themes,
    setTheme,
    colorMode,
    setColorMode,
    previewTheme,
    cancelThemePreview,
    cancelPreview,
  } = useTheme();

  const clearTimeoutRef = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const transitionTo = useCallback((next: Phase) => {
    setLeaving(true);
    timeoutRef.current = setTimeout(() => {
      setLeaving(false);
      setPhase(next);
    }, FADE_OUT_MS + FADE_GAP_MS);
  }, []);

  /* ── Center phase handlers ── */

  const handleStart = () => {
    onAccept?.();
    onInteract?.();
    timeoutRef.current = setTimeout(() => {
      transitionTo(isAuthenticated ? "intro" : "auth");
    }, 1600);
  };

  // Auto-advance from auth
  useEffect(() => {
    if (isAuthenticated && phase === "auth" && !leaving) {
      onInteract?.();
      transitionTo("intro");
    }
  }, [isAuthenticated, phase, leaving, onInteract, transitionTo]);

  // Intro fade-in
  useEffect(() => {
    if (phase !== "intro") return;
    const t = setTimeout(() => setRippleActive(true), 400);
    return () => clearTimeout(t);
  }, [phase]);

  const handleIntroContinue = () => {
    onInteract?.();
    onEnterSplit?.();
    transitionTo("browser");
  };

  /* ── Split phase navigation ── */

  const nextSplitStep = () => {
    const idx = SPLIT_STEP_ORDER.indexOf(phase);
    if (idx < SPLIT_STEP_ORDER.length - 1) {
      onInteract?.();
      transitionTo(SPLIT_STEP_ORDER[idx + 1]);
    } else {
      // Last step done
      onInteract?.();
      transitionTo("complete");
    }
  };

  // Complete
  useEffect(() => {
    clearTimeoutRef();
    if (phase === "complete") {
      timeoutRef.current = setTimeout(() => {
        setPhase("done");
        onComplete();
      }, 600);
      return clearTimeoutRef;
    }
    return clearTimeoutRef;
  }, [phase, onComplete, clearTimeoutRef]);

  /* ── Discovery confirm ── */
  const handleDiscoveryConfirm = () => {
    const selected = (Object.entries(categoryStates) as [DiscoveryCategory, boolean][])
      .filter(([, enabled]) => enabled)
      .map(([id]) => id);
    localStorage.setItem(DISCOVERY_CATEGORIES_KEY, JSON.stringify(selected));
    onDiscoveryConfirm?.(selected);
    nextSplitStep();
  };

  const handleToggleCategory = (id: DiscoveryCategory) => {
    setCategoryStates((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  /* ── Theme select ── */
  const handleThemeSelect = (id: string) => {
    setTheme(id);
    cancelPreview();
  };

  if (phase === "done") return null;

  const isCentered = CENTER_PHASES.has(phase);
  const isSplit = SPLIT_PHASES.has(phase);
  const isComplete = phase === "complete";

  const sortedThemes = [...themes].sort((a, b) => a.name.localeCompare(b.name));
  const platform = window.electronAPI?.platform ?? "unknown";

  return (
    <div
      className={`onboarding-dialogue ${isSplit ? "onboarding-dialogue--split" : ""}`}
      data-phase={phase}
      data-leaving={leaving}
      style={{ display: isComplete ? "none" : undefined }}
    >
      {/* ════ CENTER PHASES ════ */}

      {phase === "start" && (
        <div className="onboarding-moment onboarding-moment--start">
          <button className="onboarding-start-button" onClick={handleStart}>
            Start Stella
          </button>
        </div>
      )}

      {phase === "auth" && (
        <div className="onboarding-moment onboarding-moment--auth">
          <div className="onboarding-text">Sign in to begin</div>
          <InlineAuth />
        </div>
      )}

      {phase === "intro" && (
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
            <button className="onboarding-choice" onClick={handleIntroContinue}>
              Continue
            </button>
          </div>
        </div>
      )}

      {/* ════ SPLIT PHASES ════ */}

      {isSplit && (
        <>
          {/* Right: title + step content */}
          <div className="onboarding-split-right">
            {STEP_TITLES[phase] && (
              <div className="onboarding-split-title">{STEP_TITLES[phase]}</div>
            )}

            {/* ── Browser ── */}
            {phase === "browser" && (
              <div className="onboarding-step-content">
                <p className="onboarding-step-desc">
                  I can use your browser to look things up and take actions for you. I'll stay in my own tab and won't get in your way.
                </p>
                <div className="onboarding-step-label">Which browser do you use?</div>
                <div className="onboarding-pills">
                  {BROWSERS.filter((b) => platform !== "darwin" ? b.id !== "safari" : true).map((b) => (
                    <button
                      key={b.id}
                      className="onboarding-pill"
                      data-active={selectedBrowser === b.id}
                      onClick={() => setSelectedBrowser(b.id)}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
                <button
                  className="onboarding-confirm"
                  data-visible={selectedBrowser !== null}
                  onClick={nextSplitStep}
                >
                  Continue
                </button>
              </div>
            )}

            {/* ── Discovery ── */}
            {phase === "discovery" && (
              <div className="onboarding-step-content">
                <p className="onboarding-step-desc">
                  The more I know, the more I can help. Pick what you're comfortable sharing.
                </p>
                <OnboardingDiscovery
                  categoryStates={categoryStates}
                  onToggleCategory={handleToggleCategory}
                  onConfirm={handleDiscoveryConfirm}
                />
              </div>
            )}

            {/* ── Memory ── */}
            {phase === "memory" && (
              <div className="onboarding-step-content">
                <p className="onboarding-step-desc">
                  We don't have separate conversations. You can talk to me about anything, anytime, and I'll remember.
                </p>
                <p className="onboarding-step-desc">
                  No starting over. No repeating yourself.
                </p>
                <button className="onboarding-confirm" data-visible={true} onClick={nextSplitStep}>
                  Continue
                </button>
              </div>
            )}

            {/* ── Creation ── */}
            {phase === "creation" && (
              <div className="onboarding-step-content">
                <p className="onboarding-step-desc">
                  I can create apps, edit your files, build things right next to our conversation, and even improve myself over time.
                </p>
                <p className="onboarding-step-desc">
                  Anything I make, you can share with others.
                </p>
                <button className="onboarding-confirm" data-visible={true} onClick={nextSplitStep}>
                  Continue
                </button>
              </div>
            )}

            {/* ── Phone ── */}
            {phase === "phone" && (
              <div className="onboarding-step-content">
                <p className="onboarding-step-desc">
                  You can message me from your phone. If your computer is on, I can take action on it for you.
                </p>
                <p className="onboarding-step-desc">
                  If your computer is off, I'll still respond, but I can't act unless you give me a{" "}
                  <button className="onboarding-inline-link" onClick={() => { /* TODO: show Home info */ }}>
                    Home
                  </button>
                  .
                </p>
                <p className="onboarding-step-subdesc">
                  A Home lets me work for you 24/7, even when your computer is off.
                </p>
                <button className="onboarding-confirm" data-visible={true} onClick={nextSplitStep}>
                  Continue
                </button>
              </div>
            )}

            {/* ── Theme ── */}
            {phase === "theme" && (
              <div className="onboarding-step-content">
                <div className="onboarding-step-label">Appearance</div>
                <div className="onboarding-theme-row">
                  {(["light", "dark", "system"] as const).map((mode) => (
                    <button
                      key={mode}
                      className="onboarding-pill"
                      data-active={colorMode === mode}
                      onClick={() => setColorMode(mode)}
                    >
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                </div>

                <div className="onboarding-step-label">Theme</div>
                <div
                  className="onboarding-theme-grid"
                  onMouseLeave={() => cancelThemePreview()}
                >
                  {sortedThemes.map((t) => (
                    <button
                      key={t.id}
                      className="onboarding-pill"
                      data-active={t.id === themeId}
                      onClick={() => handleThemeSelect(t.id)}
                      onMouseEnter={() => previewTheme(t.id)}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>

                <button className="onboarding-confirm" data-visible={true} onClick={nextSplitStep}>
                  Continue
                </button>
              </div>
            )}

            {/* ── Personality ── */}
            {phase === "personality" && (
              <div className="onboarding-step-content">
                <p className="onboarding-step-desc">
                  Should I use emojis when we talk?
                </p>
                <div className="onboarding-pills">
                  <button
                    className="onboarding-pill"
                    data-active={useEmojis === true}
                    onClick={() => setUseEmojis(true)}
                  >
                    Expressive
                  </button>
                  <button
                    className="onboarding-pill"
                    data-active={useEmojis === false}
                    onClick={() => setUseEmojis(false)}
                  >
                    Minimal
                  </button>
                </div>
                <button
                  className="onboarding-confirm"
                  data-visible={useEmojis !== null}
                  onClick={nextSplitStep}
                >
                  Finish
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
