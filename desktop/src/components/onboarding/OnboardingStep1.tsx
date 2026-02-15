import React, { useState, useEffect, useRef, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import {
  SPLIT_PHASES,
  SPLIT_STEP_ORDER,
  DISCOVERY_CATEGORIES_KEY,
  BROWSER_SELECTION_KEY,
  BROWSER_PROFILE_KEY,
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
  browser: "Let me get to know you.",
  creation: "I'm not just a desktop app.",
  theme: "How should I look?",
  personality: "How should I talk?",
};


/* ── Creation conversation steps ── */
const CREATION_STEPS = [
  {
    userText: "Make me a beat maker",
    stellaReply: "Here — I built you a step sequencer.",
    action: "djstudio" as const,
  },
  {
    userText: "Show me live weather",
    stellaReply: "Here — live weather, updating in real time.",
    action: "weather" as const,
  },
  {
    userText: "Can you modify yourself?",
    stellaReply: "I can modify myself, self-improve, learn skills, and even change how everything looks on your screen.",
    action: "selfmod" as const,
  },
];

export const OnboardingStep1: React.FC<OnboardingStep1Props> = ({
  onComplete,
  onAccept,
  onInteract,
  onDiscoveryConfirm,
  onEnterSplit,
  onDemoChange,
  isAuthenticated,
}) => {
  const [phase, setPhase] = useState<Phase>("start");
  const [leaving, setLeaving] = useState(false);
  const [rippleActive, setRippleActive] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Browser selection
  const [selectedBrowser, setSelectedBrowser] = useState<BrowserId | null>(null);
  const [detectedBrowser, setDetectedBrowser] = useState<BrowserId | null>(null);
  const [detectedProfile, setDetectedProfile] = useState<string | null>(null);
  const [homeHovered, setHomeHovered] = useState(false);

  // Discovery category toggles
  const [categoryStates, setCategoryStates] = useState<Record<DiscoveryCategory, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const cat of DISCOVERY_CATEGORIES) {
      initial[cat.id] = cat.defaultEnabled;
    }
    return initial as Record<DiscoveryCategory, boolean>;
  });

  // Personality
  const [expressionStyle, setExpressionStyle] = useState<"emotes" | "emoji" | "none" | null>(null);
  const saveExpressionStyle = useMutation(api.data.preferences.setExpressionStyle);
  const savePreferredBrowser = useMutation(api.data.preferences.setPreferredBrowser);

  // Phone — hover reveal

  // Creation conversation — mock chat that opens onboarding demo panels
  type ChatMsg = { role: "stella" | "user"; text: string };
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([
    { role: "stella", text: "Anything you need, I can make it — apps, live dashboards, creative tools, things that appear right here while we talk. And I\u2019m not static. I can learn new abilities, change how I work, and even completely redesign my own interface. The way I look, the way I behave, what I can do — you shape all of it." },
  ]);
  const [chatStep, setChatStep] = useState(0);
  const [chatTyping, setChatTyping] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [selfmodLevel, setSelfmodLevel] = useState<"low" | "medium" | "high" | null>(null);

  const handleChatSend = useCallback(() => {
    if (chatStep >= CREATION_STEPS.length || chatTyping) return;
    const step = CREATION_STEPS[chatStep];
    setChatMessages((prev) => [...prev, { role: "user", text: step.userText }]);
    setChatTyping(true);
    setTimeout(() => {
      setChatMessages((prev) => [...prev, { role: "stella", text: step.stellaReply }]);
      setChatTyping(false);
      setChatStep((prev) => prev + 1);
      if (step.action === "djstudio") {
        onDemoChange?.("dj-studio");
      } else if (step.action === "weather") {
        onDemoChange?.("weather-station");
      } else {
        onDemoChange?.(null);
      }
    }, 700);
  }, [chatStep, chatTyping, onDemoChange]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, chatTyping]);

  // Hide real sidebar during onboarding
  useEffect(() => {
    const shell = document.querySelector(".window-shell");
    if (!shell) return;
    shell.setAttribute("data-onboarding", "");
    return () => shell.removeAttribute("data-onboarding");
  }, []);

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
  const selfmodExitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const shell = document.querySelector(".window-shell");
    if (!shell) return;
    if (phase === "creation" && selfmodLevel) {
      if (selfmodExitTimer.current) {
        clearTimeout(selfmodExitTimer.current);
        selfmodExitTimer.current = null;
      }
      shell.removeAttribute("data-selfmod-exiting");
      shell.setAttribute("data-selfmod-demo", selfmodLevel);
    } else if (shell.hasAttribute("data-selfmod-demo")) {
      // Smooth exit: keep demo attr so pseudo-elements still exist, overlay exiting to fade out
      shell.setAttribute("data-selfmod-exiting", "");
      selfmodExitTimer.current = setTimeout(() => {
        shell.removeAttribute("data-selfmod-demo");
        shell.removeAttribute("data-selfmod-exiting");
        selfmodExitTimer.current = null;
      }, 600);
    }
    return () => {
      shell.removeAttribute("data-selfmod-demo");
      shell.removeAttribute("data-selfmod-exiting");
      if (selfmodExitTimer.current) {
        clearTimeout(selfmodExitTimer.current);
        selfmodExitTimer.current = null;
      }
    };
  }, [phase, selfmodLevel]);

  // Close demo panel when leaving creation phase
  useEffect(() => {
    if (phase !== "creation") {
      onDemoChange?.(null);
    }
  }, [phase, onDemoChange]);

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

  useEffect(() => {
    if (phase !== "browser" || selectedBrowser) return;

    let cancelled = false;

    const preselectBrowser = async () => {
      try {
        const detected = await window.electronAPI?.detectPreferredBrowser?.();
        if (cancelled || !detected?.browser) return;

        const supportedBrowserIds = new Set(BROWSERS.map((browser) => browser.id));
        const detectedId = detected.browser as BrowserId;
        if (!supportedBrowserIds.has(detectedId)) return;

        setSelectedBrowser(detectedId);
        setDetectedBrowser(detectedId);
        setDetectedProfile(detected.profile ?? null);
      } catch {
        // Detection is best-effort only.
      }
    };

    void preselectBrowser();

    return () => {
      cancelled = true;
    };
  }, [phase, selectedBrowser]);

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

    if (selectedBrowser) {
      localStorage.setItem(BROWSER_SELECTION_KEY, selectedBrowser);
      if (detectedBrowser === selectedBrowser && detectedProfile) {
        localStorage.setItem(BROWSER_PROFILE_KEY, detectedProfile);
      } else {
        localStorage.removeItem(BROWSER_PROFILE_KEY);
      }
    } else {
      localStorage.removeItem(BROWSER_SELECTION_KEY);
      localStorage.removeItem(BROWSER_PROFILE_KEY);
    }

    void savePreferredBrowser({
      browser: selectedBrowser ?? "none",
    }).catch(() => {
      // Browser preference sync is best-effort only.
    });

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
                <div className="onboarding-step-label">What can I learn about you?</div>
                <OnboardingDiscovery
                  categoryStates={categoryStates}
                  onToggleCategory={handleToggleCategory}
                />

                <div className="onboarding-step-label">Your browser</div>
                <p className="onboarding-step-subdesc">
                  I can browse the web for you, learn your favorite sites, and pick up on how you like things done.
                </p>
                <div className="onboarding-pills">
                  {BROWSERS.filter((b) => platform !== "darwin" ? b.id !== "safari" : true).map((b) => (
                    <button
                      key={b.id}
                      className="onboarding-pill onboarding-pill--sm"
                      data-active={selectedBrowser === b.id}
                      onClick={() => {
                        setSelectedBrowser(b.id);
                        if (detectedBrowser !== b.id) {
                          setDetectedProfile(null);
                        }
                      }}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
                {detectedBrowser === selectedBrowser && detectedProfile && (
                  <p className="onboarding-step-subdesc">
                    Detected profile: {detectedProfile}
                  </p>
                )}

                <button className="onboarding-confirm" data-visible={true} onClick={handleDiscoveryConfirm}>
                  Continue
                </button>
              </div>
            )}

            {/* ── Memory + Reach ── */}
            {phase === "memory" && (
              <div className="onboarding-step-content">
                <div className="onboarding-section-title">I'm always here, and I never forget.</div>
                <p className="onboarding-step-desc">
                  We don't have separate conversations. You can talk to me about anything, anytime, and I'll remember.
                </p>
                <p className="onboarding-step-desc">
                  No starting over. No repeating yourself.
                </p>

                <div className="onboarding-section-title">You can reach me anywhere.</div>
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

            {/* ── Creation (mock conversation with mimicked sidebar) ── */}
            {phase === "creation" && (
              <div className="onboarding-step-content onboarding-creation-chat">
                <div className="onboarding-mock-app">
                  {/* Mock main area */}
                  <div className="onboarding-mock-main">
                    <div className="onboarding-chat-messages" ref={chatScrollRef}>
                      {chatMessages.map((msg, i) => (
                        <div
                          key={i}
                          className={`onboarding-chat-msg onboarding-chat-msg--${msg.role}`}
                        >
                          <span className="onboarding-chat-bubble">{msg.text}</span>
                        </div>
                      ))}
                      {chatTyping && (
                        <div className="onboarding-chat-msg onboarding-chat-msg--stella">
                          <span className="onboarding-chat-typing">
                            <span /><span /><span />
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="onboarding-chat-composer">
                      <span key={chatStep} className="onboarding-chat-input">
                        {chatStep < CREATION_STEPS.length ? CREATION_STEPS[chatStep].userText : "Ask me anything..."}
                      </span>
                      <button
                        className="onboarding-chat-send"
                        onClick={handleChatSend}
                        disabled={chatTyping || chatStep >= CREATION_STEPS.length}
                        data-hidden={chatStep >= CREATION_STEPS.length || undefined}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Selfmod controls — always rendered, CSS grid animates reveal */}
                <div className="onboarding-creation-controls" data-visible={chatStep >= CREATION_STEPS.length || undefined}>
                  <div className="onboarding-creation-controls-inner">
                    <div className="onboarding-chat-selfmod">
                      <div className="onboarding-selfmod-levels">
                        <button
                          className="onboarding-selfmod-level"
                          data-active={selfmodLevel === "low"}
                          onClick={() => handleSelfmodLevel("low")}
                        >
                          <span className="onboarding-selfmod-level-label">"Make my messages blue"</span>
                        </button>
                        <button
                          className="onboarding-selfmod-level"
                          data-active={selfmodLevel === "medium"}
                          onClick={() => handleSelfmodLevel("medium")}
                        >
                          <span className="onboarding-selfmod-level-label">"Make the chat feel more modern"</span>
                        </button>
                        <button
                          className="onboarding-selfmod-level"
                          data-active={selfmodLevel === "high"}
                          onClick={() => handleSelfmodLevel("high")}
                        >
                          <span className="onboarding-selfmod-level-label">"Give everything a cozy cat theme"</span>
                        </button>
                      </div>
                    </div>
                    <button className="onboarding-confirm" data-visible={chatStep >= CREATION_STEPS.length} onClick={nextSplitStep}>
                      Continue
                    </button>
                  </div>
                </div>
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

                <div className="onboarding-step-label">Background</div>
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
                </div>

                <div className="onboarding-step-label">Color intensity</div>
                <div className="onboarding-theme-row">
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
                  {(["emotes", "emoji", "none"] as const).map((style) => (
                    <button
                      key={style}
                      className="onboarding-pill"
                      data-active={expressionStyle === style}
                      onClick={() => {
                        setExpressionStyle(style);
                        const backendStyle = style === "none" ? "none" as const : "emoji" as const;
                        saveExpressionStyle({ style: backendStyle }).catch(() => {});
                      }}
                    >
                      {style.charAt(0).toUpperCase() + style.slice(1)}
                    </button>
                  ))}
                </div>
                {expressionStyle && (
                  <p className="onboarding-personality-preview">
                    {expressionStyle === "emotes" && (<>Got it! I'll get that done for you <img src="/emotes/assets/7tv/catNOD-7eeffb97edbf.webp" alt="catNOD" className="onboarding-emote-preview" /></>)}
                    {expressionStyle === "emoji" && "Got it! I'll get that done for you 😊"}
                    {expressionStyle === "none" && "Got it. I'll get that done for you."}
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

          {/* Bottom nav bar — full width, outside split-right (high selfmod only) */}
          {phase === "creation" && selfmodLevel === "high" && (
            <nav className="onboarding-bottom-bar" aria-hidden="true">
              <div className="onboarding-bottom-bar-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
                <span>Apps</span>
              </div>
              <div className="onboarding-bottom-bar-item onboarding-bottom-bar-item--active">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                <span>Chat</span>
              </div>
              <div className="onboarding-bottom-bar-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
                <span>Connect</span>
              </div>
              <div className="onboarding-bottom-bar-item">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                <span>Settings</span>
              </div>
            </nav>
          )}
        </>
      )}
    </div>
  );
};

