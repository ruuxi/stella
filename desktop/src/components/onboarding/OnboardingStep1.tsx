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
import { useCanvas } from "../../app/state/canvas-state";
import "../Onboarding.css";

const FADE_OUT_MS = 400;
const FADE_GAP_MS = 200;

/* ── Step title text (shown on left in split mode) ── */
const STEP_TITLES: Partial<Record<Phase, string>> = {
  browser: "Let me get to know you.",
  memory: "You won't have to repeat yourself.",
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
  const [expressionStyle, setExpressionStyle] = useState<"emotes" | "emoji" | "standard" | null>(null);

  // Phone — hover reveal
  const [homeHovered, setHomeHovered] = useState(false);

  // Creation examples — open real canvas panels
  const { openCanvas, closeCanvas } = useCanvas();
  const [creationExample, setCreationExample] = useState<"djstudio" | "weather" | "selfmod" | null>(null);
  const [selfmodLevel, setSelfmodLevel] = useState<"low" | "medium" | "high" | null>(null);

  const handleCreationExample = useCallback((id: "djstudio" | "weather" | "selfmod") => {
    if (creationExample === id) {
      // Toggle off
      setCreationExample(null);
      closeCanvas();
      return;
    }
    setCreationExample(id);
    if (id === "djstudio") {
      openCanvas({ name: "dj-studio", title: "Stella Beats" });
    } else if (id === "weather") {
      openCanvas({ name: "weather-station", title: "Weather Station" });
    } else {
      // selfmod — no canvas panel
      closeCanvas();
    }
  }, [creationExample, openCanvas, closeCanvas]);
  const selfmodFading = useRef(false);

  // Fade-through when transitioning to/from "high" (layout changes can't CSS-transition)
  const handleSelfmodLevel = useCallback((next: "low" | "medium" | "high" | null) => {
    const prev = selfmodLevel;
    if (next === prev) next = null; // toggle off

    const needsFade = prev === "high" || next === "high";
    if (!needsFade || selfmodFading.current) {
      setSelfmodLevel(next);
      return;
    }

    const shell = document.querySelector(".window-shell");
    if (!shell) { setSelfmodLevel(next); return; }

    selfmodFading.current = true;
    shell.setAttribute("data-selfmod-fading", "");
    setTimeout(() => {
      setSelfmodLevel(next);
      setTimeout(() => {
        shell.removeAttribute("data-selfmod-fading");
        selfmodFading.current = false;
      }, 50);
    }, 300);
  }, [selfmodLevel]);

  // Apply/remove selfmod demo on the actual app shell
  useEffect(() => {
    const shell = document.querySelector(".window-shell");
    if (!shell) return;
    if (phase === "creation" && selfmodLevel) {
      shell.setAttribute("data-selfmod-demo", selfmodLevel);
    } else {
      shell.removeAttribute("data-selfmod-demo");
    }
    return () => {
      shell.removeAttribute("data-selfmod-demo");
    };
  }, [phase, selfmodLevel]);

  // Close canvas when leaving creation phase
  useEffect(() => {
    if (phase !== "creation") {
      closeCanvas();
      setCreationExample(null);
    }
  }, [phase, closeCanvas]);

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
    gradientMode,
    setGradientMode,
    gradientColor,
    setGradientColor,
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
    setLeaving(true);
    onAccept?.();
    onInteract?.();
    timeoutRef.current = setTimeout(() => {
      setLeaving(false);
      setPhase(isAuthenticated ? "intro" : "auth");
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

            {/* ── Browser + Discovery (combined) ── */}
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
                <p className="onboarding-step-subdesc">
                  Pick the browser you use most — your personal one works best.
                </p>

                <div className="onboarding-section-divider" />

                <div className="onboarding-step-label">What can I learn about you?</div>
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

                <div className="onboarding-step-label">Things I can make for you</div>
                <div className="onboarding-creation-examples">
                  <button
                    className="onboarding-creation-card"
                    data-active={creationExample === "djstudio"}
                    onClick={() => handleCreationExample("djstudio")}
                  >
                    <span className="onboarding-creation-card-title">A beat maker</span>
                    <span className="onboarding-creation-card-desc">Opens right next to our chat</span>
                  </button>
                  <button
                    className="onboarding-creation-card"
                    data-active={creationExample === "weather"}
                    onClick={() => handleCreationExample("weather")}
                  >
                    <span className="onboarding-creation-card-title">A live weather station</span>
                    <span className="onboarding-creation-card-desc">Real-time data in a side panel</span>
                  </button>
                  <button
                    className="onboarding-creation-card"
                    data-active={creationExample === "selfmod"}
                    onClick={() => handleCreationExample("selfmod")}
                  >
                    <span className="onboarding-creation-card-title">A better version of me</span>
                    <span className="onboarding-creation-card-desc">I can learn new skills over time</span>
                  </button>
                </div>
                {creationExample === "selfmod" && (
                  <div className="onboarding-creation-preview">
                    <div className="onboarding-creation-mock-selfmod">
                      <div className="mock-selfmod-item">
                        <span className="mock-selfmod-badge">New skill</span>
                        <span className="mock-selfmod-name">Daily briefing</span>
                        <span className="mock-selfmod-desc">I'll bring you the news and your schedule every morning at 10am.</span>
                      </div>
                      <div className="mock-selfmod-item">
                        <span className="mock-selfmod-badge">Improved</span>
                        <span className="mock-selfmod-name">Grocery lists</span>
                        <span className="mock-selfmod-desc">I learned which stores you prefer and sort your list by aisle.</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="onboarding-section-divider" />

                <div className="onboarding-step-label">I can also change how this app works</div>
                <p className="onboarding-step-subdesc">
                  Just ask, and I'll redesign parts of this app to fit you better.
                </p>
                <div className="onboarding-selfmod-levels">
                  <button
                    className="onboarding-selfmod-level"
                    data-active={selfmodLevel === "low"}
                    onClick={() => handleSelfmodLevel("low")}
                  >
                    <span className="onboarding-selfmod-level-label">Small tweak</span>
                    <span className="onboarding-selfmod-level-desc">A subtle change</span>
                  </button>
                  <button
                    className="onboarding-selfmod-level"
                    data-active={selfmodLevel === "medium"}
                    onClick={() => handleSelfmodLevel("medium")}
                  >
                    <span className="onboarding-selfmod-level-label">New feature</span>
                    <span className="onboarding-selfmod-level-desc">Something added</span>
                  </button>
                  <button
                    className="onboarding-selfmod-level"
                    data-active={selfmodLevel === "high"}
                    onClick={() => handleSelfmodLevel("high")}
                  >
                    <span className="onboarding-selfmod-level-label">Full redesign</span>
                    <span className="onboarding-selfmod-level-desc">A whole new look</span>
                  </button>
                </div>
                <p className="onboarding-selfmod-caption" data-visible={selfmodLevel !== null}>
                  {selfmodLevel === "low" && "Look around — the sidebar and composer just changed a little."}
                  {selfmodLevel === "medium" && "The sidebar is wider, the composer is different, and the layout shifted."}
                  {selfmodLevel === "high" && "Cat mode — bottom dock, apps bar, paw cursor, warm palette. I can theme the whole app anytime you ask."}
                  {!selfmodLevel && "\u00A0"}
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
                  If your computer is off, I'll still respond, but I can't act unless you give me{" "}
                  <span
                    className="onboarding-inline-link"
                    onMouseEnter={() => setHomeHovered(true)}
                    onMouseLeave={() => setHomeHovered(false)}
                  >
                    another home
                  </span>
                  .
                </p>
                <p className="onboarding-home-hint" data-visible={homeHovered}>
                  You can get me a server so I have another home and I'm always on.
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

                <div className="onboarding-step-label">Feel</div>
                <div className="onboarding-theme-row">
                  {(["soft", "crisp"] as const).map((mode) => (
                    <button
                      key={mode}
                      className="onboarding-pill"
                      data-active={gradientMode === mode}
                      onClick={() => setGradientMode(mode)}
                    >
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                  {(["relative", "strong"] as const).map((color) => (
                    <button
                      key={color}
                      className="onboarding-pill"
                      data-active={gradientColor === color}
                      onClick={() => setGradientColor(color)}
                    >
                      {color.charAt(0).toUpperCase() + color.slice(1)}
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
                <div className="onboarding-pills">
                  {(["emotes", "emoji", "standard"] as const).map((style) => (
                    <button
                      key={style}
                      className="onboarding-pill"
                      data-active={expressionStyle === style}
                      onClick={() => setExpressionStyle(style)}
                    >
                      {style.charAt(0).toUpperCase() + style.slice(1)}
                    </button>
                  ))}
                </div>
                {expressionStyle && (
                  <p className="onboarding-personality-preview">
                    {expressionStyle === "emotes" && (<>Got it! I'll get that done for you <img src="/emotes/assets/7tv/catNOD-7eeffb97edbf.webp" alt="catNOD" className="onboarding-emote-preview" /></>)}
                    {expressionStyle === "emoji" && "Got it! I'll get that done for you 😊"}
                    {expressionStyle === "standard" && "Got it. I'll get that done for you."}
                  </p>
                )}
                <button
                  className="onboarding-confirm"
                  data-visible={expressionStyle !== null}
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
