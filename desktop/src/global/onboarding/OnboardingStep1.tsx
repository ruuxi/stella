import React, { useState, useEffect, useRef, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import {
  BROWSER_PROFILE_KEY,
  BROWSER_SELECTION_KEY,
  DISCOVERY_CATEGORIES_CHANGED_EVENT,
  DISCOVERY_CATEGORIES_KEY,
  type DiscoveryCategory,
} from "@/shared/contracts/discovery";
import {
  SPLIT_PHASES,
  SPLIT_STEP_ORDER,
  DISCOVERY_CATEGORIES,
  BROWSERS,
  type Phase,
  type BrowserId,
  type OnboardingStep1Props,
} from "./use-onboarding-state";
import { OnboardingDiscovery } from "./OnboardingDiscovery";
import { OnboardingMockWindows } from "./OnboardingMockWindows";
import { useTheme, useThemeControl } from "@/context/theme-context";
import { getPlatform } from "@/platform/electron/platform";
import { OnboardingReveal } from "./OnboardingReveal";
import { OnboardingSelectionTile } from "./OnboardingSelectionTile";
import "./Onboarding.css";
import "@/global/onboarding/selfmod-demo.css";

const FADE_OUT_MS = 400;
const FADE_GAP_MS = 200;

/* ── Step title text (shown on left in split mode) ── */
const STEP_TITLES: Partial<Record<Phase, string>> = {
  browser: "Let me get to know you.",
  creation: "I'm not just a desktop app.",
  voice: "Speak your mind.",
  theme: "How should I look?",
  personality: "How should I talk?",
};

/* ── Showcase options for creation phase ── */
type ShowcaseId = "modern" | "cozy-cat" | "dj-studio" | "weather";

const SHOWCASE_OPTIONS: {
  id: ShowcaseId;
  label: string;
  description: string;
}[] = [
  { id: "modern", label: "Modernize the chat", description: "Glass effects, blue accents, refined layout" },
  { id: "cozy-cat", label: "Give everything a cozy cat theme", description: "A complete theme overhaul" },
  { id: "dj-studio", label: "Build me a beat maker", description: "A full step sequencer with synths" },
  { id: "weather", label: "Live weather dashboard", description: "Real-time weather with animations" },
];


export const OnboardingStep1: React.FC<OnboardingStep1Props> = ({
  onComplete,
  onAccept,
  onInteract,
  onDiscoveryConfirm,
  onEnterSplit,
  onSelectionChange,
  onDemoChange,
  demoMorphing,
  isAuthenticated,
}) => {
  const [phase, setPhase] = useState<Phase>("start");
  const [leaving, setLeaving] = useState(false);
  const [rippleActive, setRippleActive] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Browser selection
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [selectedBrowser, setSelectedBrowser] = useState<BrowserId | null>(
    null,
  );
  const [detectedBrowser, setDetectedBrowser] = useState<BrowserId | null>(
    null,
  );
  const [availableProfiles, setAvailableProfiles] = useState<
    { id: string; name: string }[]
  >([]);
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [showNoneWarning, setShowNoneWarning] = useState(false);
  const [activeMockId, setActiveMockId] = useState<string | null>(null);
  const [voicePermissionGranted, setVoicePermissionGranted] = useState<
    boolean | null
  >(null);

  // Discovery category toggles
  const [categoryStates, setCategoryStates] = useState<
    Record<DiscoveryCategory, boolean>
  >(() => {
    const initial: Record<string, boolean> = {};
    for (const cat of DISCOVERY_CATEGORIES) {
      initial[cat.id] = cat.defaultEnabled;
    }
    return initial as Record<DiscoveryCategory, boolean>;
  });

  // Notify parent when selections change
  useEffect(() => {
    const hasAny =
      Object.values(categoryStates).some((v) => v) || browserEnabled;
    onSelectionChange?.(hasAny);
  }, [categoryStates, browserEnabled, onSelectionChange]);

  // Personality
  const [expressionStyle, setExpressionStyle] = useState<
    "emotes" | "emoji" | "none" | null
  >(null);
  const saveExpressionStyle = useMutation(
    api.data.preferences.setExpressionStyle,
  );
  const savePreferredBrowser = useMutation(
    api.data.preferences.setPreferredBrowser,
  );

  // Creation showcase
  const [activeShowcase, setActiveShowcase] = useState<ShowcaseId | null>(null);

  const handleShowcaseSelect = useCallback(
    (id: ShowcaseId) => {
      if (demoMorphing) return;

      const next = activeShowcase === id ? null : id;
      setActiveShowcase(next);

      // Map to demo (morph animation handled by OnboardingCanvas)
      if (next === null) onDemoChange?.("default");
      else if (next === "modern") onDemoChange?.("modern");
      else if (next === "dj-studio") onDemoChange?.("dj-studio");
      else if (next === "weather") onDemoChange?.("weather-station");
      else if (next === "cozy-cat") onDemoChange?.("cozy-cat");
    },
    [activeShowcase, demoMorphing, onDemoChange],
  );

  // Hide real sidebar during onboarding
  useEffect(() => {
    const shell = document.querySelector(".window-shell");
    if (!shell) return;
    shell.setAttribute("data-onboarding", "");
    return () => shell.removeAttribute("data-onboarding");
  }, []);

  // Show default demo when entering creation phase, close when leaving
  useEffect(() => {
    if (phase === "creation" && !leaving) {
      onDemoChange?.("default");
    } else {
      onDemoChange?.(null);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- phase change must reset showcase state immediately
      setActiveShowcase(null);
    }
  }, [phase, leaving, onDemoChange]);


  // Theme (inline)
  const { themeId, themes, colorMode, gradientMode, gradientColor } =
    useTheme();
  const {
    setTheme,
    setColorMode,
    previewTheme,
    cancelThemePreview,
    cancelPreview,
    setGradientMode,
    setGradientColor,
  } = useThemeControl();

  const clearTimeoutRef = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const transitionTo = useCallback(
    (next: Phase) => {
      clearTimeoutRef();
      setLeaving(true);
      timeoutRef.current = setTimeout(() => {
        setLeaving(false);
        setPhase(next);
      }, FADE_OUT_MS + FADE_GAP_MS);
    },
    [clearTimeoutRef],
  );

  /* ── Center phase handlers ── */

  const handleStart = () => {
    clearTimeoutRef();
    setLeaving(true);
    onAccept?.();
    onInteract?.();
    timeoutRef.current = setTimeout(() => {
      setLeaving(false);
      setPhase("intro");
    }, 1600);
  };

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

  // When browser is toggled on, detect the default browser
  useEffect(() => {
    if (!browserEnabled || detectedBrowser) return;

    let cancelled = false;

    const detectBrowser = async () => {
      try {
        const detected = await window.electronAPI?.browser.detectPreferred?.();
        if (cancelled || !detected?.browser) return;

        const supportedBrowserIds = new Set(
          BROWSERS.map((browser) => browser.id),
        );
        const detectedId = detected.browser as BrowserId;
        if (!supportedBrowserIds.has(detectedId)) return;

        setDetectedBrowser(detectedId);
        setSelectedBrowser(detectedId);
      } catch {
        // Detection is best-effort only.
      }
    };

    void detectBrowser();

    return () => {
      cancelled = true;
    };
  }, [browserEnabled, detectedBrowser]);

  // Load profiles when browser selection changes
  useEffect(() => {
    if (!selectedBrowser) return;

    let cancelled = false;

    const loadProfiles = async () => {
      try {
        const profiles =
          await window.electronAPI?.browser.listProfiles?.(selectedBrowser);
        if (!cancelled && profiles) {
          setAvailableProfiles(profiles);
          setSelectedProfile((currentProfile) => {
            if (
              currentProfile &&
              profiles.some((profile) => profile.id === currentProfile)
            ) {
              return currentProfile;
            }
            return profiles.length > 0 ? profiles[0].id : null;
          });
        }
      } catch {
        if (!cancelled) {
          setAvailableProfiles([]);
          setSelectedProfile(null);
        }
      }
    };

    void loadProfiles();

    return () => {
      cancelled = true;
    };
  }, [selectedBrowser]);

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
    if (phase === "complete") {
      clearTimeoutRef();
      timeoutRef.current = setTimeout(() => {
        setPhase("done");
        onComplete();
      }, 600);
    }
    return clearTimeoutRef;
  }, [phase, onComplete, clearTimeoutRef]);

  useEffect(() => {
    return () => {
      clearTimeoutRef();
    };
  }, [clearTimeoutRef]);

  /* ── Discovery confirm ── */
  const handleDiscoveryConfirm = () => {
    const selected = (
      Object.entries(categoryStates) as [DiscoveryCategory, boolean][]
    )
      .filter(([, enabled]) => enabled)
      .map(([id]) => id);

    // Show warning on first attempt if nothing is selected
    const nothingSelected = selected.length === 0 && !browserEnabled;
    if (nothingSelected && !showNoneWarning) {
      setShowNoneWarning(true);
      return;
    }

    localStorage.setItem(DISCOVERY_CATEGORIES_KEY, JSON.stringify(selected));
    window.dispatchEvent(new Event(DISCOVERY_CATEGORIES_CHANGED_EVENT));

    if (browserEnabled && selectedBrowser) {
      localStorage.setItem(BROWSER_SELECTION_KEY, selectedBrowser);
      if (selectedProfile) {
        localStorage.setItem(BROWSER_PROFILE_KEY, selectedProfile);
      } else {
        localStorage.removeItem(BROWSER_PROFILE_KEY);
      }
    } else {
      localStorage.removeItem(BROWSER_SELECTION_KEY);
      localStorage.removeItem(BROWSER_PROFILE_KEY);
    }

    if (isAuthenticated) {
      const preferredBrowser =
        browserEnabled && selectedBrowser ? selectedBrowser : "none";
      void savePreferredBrowser({
        browser: preferredBrowser,
      }).catch(() => {
        // Browser preference sync is best-effort only.
      });
    }

    onDiscoveryConfirm?.(selected);
    nextSplitStep();
  };

  const handleToggleCategory = (id: DiscoveryCategory) => {
    const wasEnabled = categoryStates[id];
    setCategoryStates((prev) => ({ ...prev, [id]: !prev[id] }));
    setShowNoneWarning(false);
    if (!wasEnabled) {
      setActiveMockId(id);
    } else if (activeMockId === id) {
      // Toggled off the active one — show the first remaining enabled, or null
      const remaining = Object.entries(categoryStates)
        .filter(([k, v]) => k !== id && v)
        .map(([k]) => k);
      setActiveMockId(browserEnabled ? "browser" : (remaining[0] ?? null));
    }
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
  const platform = getPlatform();
  const renderThemeOptionRow = <T extends string>(
    label: string,
    options: readonly T[],
    selectedValue: T,
    onSelect: (value: T) => void,
  ) => (
    <>
      <div className="onboarding-step-label">{label}</div>
      <div className="onboarding-theme-row">
        {options.map((option) => (
          <button
            key={option}
            className="onboarding-pill"
            data-active={selectedValue === option}
            onClick={() => onSelect(option)}
          >
            {option.charAt(0).toUpperCase() + option.slice(1)}
          </button>
        ))}
      </div>
    </>
  );

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

      {phase === "intro" && (
        <div
          className="onboarding-moment onboarding-moment--ripple"
          data-active={rippleActive}
        >
          <div className="onboarding-ripple-content">
            <div className="onboarding-text onboarding-text--fade-in">
              Stella is an AI that runs on your computer.
            </div>
            <div className="onboarding-text onboarding-text--fade-in-delayed">
              She's not made for everyone. She's made for you.
            </div>
          </div>
          <div
            className="onboarding-choices onboarding-choices--subtle"
            data-visible={rippleActive}
          >
            <button className="onboarding-choice" onClick={handleIntroContinue}>
              Continue
            </button>
          </div>
        </div>
      )}

      {/* ════ SPLIT PHASES ════ */}

      {isSplit && (
        <>
          {/* Left: mock data preview windows (browser phase only) */}
          {phase === "browser" && (
            <OnboardingMockWindows activeWindowId={activeMockId} />
          )}

          {/* Right: title + step content */}
          <div className="onboarding-split-right">
            <div
              className="onboarding-split-stage"
              data-phase={phase}
              key={phase}
            >
              {STEP_TITLES[phase] && (
                <div className="onboarding-split-title">
                  {STEP_TITLES[phase]}
                </div>
              )}

              {/* ── Browser + Discovery (combined) ── */}
              {phase === "browser" && (
                <div className="onboarding-step-content">
                  <div className="onboarding-step-label">
                    What can I learn about you?
                  </div>

                  {/* Browser as top choice with Recommended badge */}
                  <OnboardingSelectionTile
                    className="onboarding-discovery-row"
                    labelClassName="onboarding-discovery-row-label"
                    descriptionClassName="onboarding-discovery-row-desc"
                    active={browserEnabled}
                    onClick={() => {
                      const wasEnabled = browserEnabled;
                      setBrowserEnabled((prev) => !prev);
                      setShowNoneWarning(false);
                      if (wasEnabled) {
                        setSelectedBrowser(null);
                        setDetectedBrowser(null);
                        setAvailableProfiles([]);
                        setSelectedProfile(null);
                        // Toggled off — show first remaining enabled category, or null
                        if (activeMockId === "browser") {
                          const remaining = Object.entries(categoryStates)
                            .filter(([, v]) => v)
                            .map(([k]) => k);
                          setActiveMockId(remaining[0] ?? null);
                        }
                      } else {
                        setActiveMockId("browser");
                      }
                    }}
                    label={
                      <>
                        Your browser
                        <span className="onboarding-discovery-recommended">
                          Recommended
                        </span>
                      </>
                    }
                    description="I can browse the web for you, learn your favorite sites, and pick up on how you like things done"
                  />

                  {/* Expanded browser options — always rendered, CSS grid animates reveal */}
                  <OnboardingReveal
                    visible={browserEnabled}
                    className="onboarding-browser-reveal"
                    innerClassName="onboarding-browser-reveal-inner"
                  >
                    <div className="onboarding-pills">
                      {BROWSERS.filter((b) =>
                        platform !== "darwin" ? b.id !== "safari" : true,
                      ).map((b) => (
                        <button
                          key={b.id}
                          className="onboarding-pill onboarding-pill--sm"
                          data-active={selectedBrowser === b.id}
                          onClick={() => {
                            setAvailableProfiles([]);
                            setSelectedProfile(null);
                            setSelectedBrowser(b.id);
                          }}
                        >
                          {b.label}
                        </button>
                      ))}
                    </div>

                    {/* Profile selection — grid reveal */}
                    <OnboardingReveal
                      visible={availableProfiles.length > 1}
                      className="onboarding-profiles-reveal"
                      innerClassName="onboarding-profiles-reveal-inner"
                    >
                      <div className="onboarding-step-label">Profile</div>
                      <div className="onboarding-pills">
                        {availableProfiles.map((p) => (
                          <button
                            key={p.id}
                            className="onboarding-pill onboarding-pill--sm"
                            data-active={selectedProfile === p.id}
                            onClick={() => setSelectedProfile(p.id)}
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    </OnboardingReveal>
                  </OnboardingReveal>

                  <OnboardingDiscovery
                    categoryStates={categoryStates}
                    onToggleCategory={handleToggleCategory}
                  />

                  {/* Warning — always rendered, CSS grid animates reveal */}
                  <OnboardingReveal
                    visible={showNoneWarning}
                    className="onboarding-warning-reveal"
                    innerClassName="onboarding-warning-reveal-inner"
                  >
                    <div className="onboarding-discovery-warning">
                      <span className="onboarding-discovery-warning-badge">
                        Not recommended
                      </span>
                      <p className="onboarding-discovery-warning-text">
                        Without this, I'll learn about you over time through our
                        conversations. But I won't be personal to you from the
                        start.
                      </p>
                    </div>
                  </OnboardingReveal>

                  <button
                    className="onboarding-confirm"
                    data-visible={true}
                    onClick={handleDiscoveryConfirm}
                  >
                    Continue
                  </button>
                </div>
              )}

              {/* ── Creation (showcase grid) ── */}
              {phase === "creation" && (
                <div className="onboarding-step-content">
                  <p className="onboarding-step-desc">
                    Try selecting any of these — each one happens live.
                  </p>

                  <div className="onboarding-showcase-grid" style={demoMorphing ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
                    {SHOWCASE_OPTIONS.map((opt) => (
                      <OnboardingSelectionTile
                        key={opt.id}
                        className="onboarding-showcase-tile"
                        labelClassName="onboarding-showcase-tile-label"
                        descriptionClassName="onboarding-showcase-tile-desc"
                        active={activeShowcase === opt.id}
                        onClick={() => handleShowcaseSelect(opt.id)}
                        label={opt.label}
                        description={opt.description}
                      />
                    ))}
                  </div>

                  <button
                    className="onboarding-confirm"
                    data-visible={true}
                    onClick={nextSplitStep}
                  >
                    Continue
                  </button>
                </div>
              )}

              {/* ── Voice (Permission + Demo) ── */}
              {phase === "voice" && (
                <div className="onboarding-step-content">
                  <div className="onboarding-step-label">Voice Interaction</div>
                  <p className="onboarding-step-desc">
                    I can listen to your voice and instantly transcribe it for
                    you. When you're done speaking, your text will appear right
                    where you need it.
                  </p>

                  <div className="onboarding-voice-demo">
                    <button
                      className="onboarding-pill"
                      onClick={async () => {
                        try {
                          const stream =
                            await navigator.mediaDevices.getUserMedia({
                              audio: true,
                            });
                          stream.getTracks().forEach((t) => t.stop());
                          setVoicePermissionGranted(true);
                        } catch {
                          setVoicePermissionGranted(false);
                        }
                      }}
                    >
                      {voicePermissionGranted === true
                        ? "Microphone access granted \u2713"
                        : voicePermissionGranted === false
                          ? "Microphone access denied"
                          : "Allow microphone access"}
                    </button>
                  </div>

                  <div
                    className="onboarding-step-label"
                    style={{ marginTop: 24 }}
                  >
                    Voice Shortcut
                  </div>
                  <p className="onboarding-step-desc">
                    Press this shortcut anywhere to start or stop voice
                    dictation. (You can also use the Voice button in the Radial
                    Dial).
                  </p>
                  <div className="onboarding-shortcut-config">
                    <div
                      className="onboarding-pill"
                      style={{ cursor: "default", opacity: 0.8 }}
                    >
                      {platform === "darwin" ? "Cmd+Shift+V" : "Ctrl+Shift+V"}
                    </div>
                  </div>

                  <button
                    className="onboarding-confirm"
                    data-visible={true}
                    onClick={() => {
                      const finalShortcut = "CommandOrControl+Shift+V";
                      localStorage.setItem(
                        "stella-voice-shortcut",
                        finalShortcut,
                      );
                      void window.electronAPI?.voice
                        .setShortcut?.(finalShortcut)
                        .then((result) => {
                          if (
                            !result ||
                            result.activeShortcut === finalShortcut
                          ) {
                            return;
                          }
                          if (result.activeShortcut) {
                            localStorage.setItem(
                              "stella-voice-shortcut",
                              result.activeShortcut,
                            );
                            return;
                          }
                          localStorage.removeItem("stella-voice-shortcut");
                        })
                        .catch(() => {
                          // The default shortcut is already the active fallback.
                        });
                      nextSplitStep();
                    }}
                  >
                    Continue
                  </button>
                </div>
              )}

              {/* ── Theme ── */}
              {phase === "theme" && (
                <div className="onboarding-step-content">
                  {renderThemeOptionRow(
                    "Appearance",
                    ["light", "dark", "system"] as const,
                    colorMode,
                    setColorMode,
                  )}

                  {renderThemeOptionRow(
                    "Background",
                    ["soft", "crisp"] as const,
                    gradientMode,
                    setGradientMode,
                  )}

                  {renderThemeOptionRow(
                    "Color intensity",
                    ["relative", "strong"] as const,
                    gradientColor,
                    setGradientColor,
                  )}

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

                  <button
                    className="onboarding-confirm"
                    data-visible={true}
                    onClick={nextSplitStep}
                  >
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
                          const backendStyle =
                            style === "none"
                              ? ("none" as const)
                              : ("emoji" as const);
                          if (isAuthenticated) {
                            saveExpressionStyle({ style: backendStyle }).catch(
                              () => {
                                // Expression style sync is best-effort only.
                              },
                            );
                          }
                        }}
                      >
                        {style.charAt(0).toUpperCase() + style.slice(1)}
                      </button>
                    ))}
                  </div>
                  {expressionStyle && (
                    <p className="onboarding-personality-preview">
                      {expressionStyle === "emotes" && (
                        <>
                          Got it! I'll get that done for you{" "}
                          <img
                            src="/emotes/assets/7tv/catNOD-7eeffb97edbf.webp"
                            alt="catNOD"
                            className="onboarding-emote-preview"
                          />
                        </>
                      )}
                      {expressionStyle === "emoji" &&
                        "Got it! I'll get that done for you 😊"}
                      {expressionStyle === "none" &&
                        "Got it. I'll get that done for you."}
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
          </div>

        </>
      )}
    </div>
  );
};
