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
import { PREFERRED_MIC_KEY } from "@/features/voice/services/shared-microphone";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
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

/* ── Showcase icons (small inline SVGs for card headers) ── */
const ShowcaseIcons = {
  modern: (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  ),
  "cozy-cat": (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.08C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z" />
    </svg>
  ),
  "dj-studio": (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ),
  weather: (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  ),
  pomodoro: (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2 2" />
      <path d="M5 3l2 2" />
      <path d="M19 3l-2 2" />
      <path d="M12 5V3" />
    </svg>
  ),
};

/* ── Showcase options for creation phase ── */
type ShowcaseId = "modern" | "cozy-cat" | "dj-studio" | "weather" | "pomodoro";

const SHOWCASE_OPTIONS: {
  id: ShowcaseId;
  label: string;
  description: string;
  category: string;
  accent: string;
}[] = [
  { id: "modern", label: "Modernize the chat", description: "Glass panels, refined spacing, cool blue accents", category: "UI", accent: "oklch(0.6 0.18 250)" },
  { id: "cozy-cat", label: "Cozy cat theme", description: "Warm palette, playful cards, paw print decorations", category: "Theme", accent: "oklch(0.72 0.12 350)" },
  { id: "dj-studio", label: "Build a beat maker", description: "8-track step sequencer with real-time synthesis", category: "App", accent: "oklch(0.6 0.2 300)" },
  { id: "weather", label: "Weather dashboard", description: "Live forecasts, hourly charts, and smart insights", category: "Dashboard", accent: "oklch(0.65 0.15 200)" },
  { id: "pomodoro", label: "Focus timer", description: "Pomodoro sessions with ambient soundscapes", category: "Tool", accent: "oklch(0.7 0.15 60)" },
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
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string | null>(null);

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
      else if (next === "pomodoro") onDemoChange?.("pomodoro");
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

              {/* ── Creation (showcase gallery) ── */}
              {phase === "creation" && (
                <div className="onboarding-step-content">
                  <p className="onboarding-step-desc">
                    Try selecting any of these — each one happens live.
                  </p>

                  <div className="onboarding-showcase-grid" style={demoMorphing ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
                    {SHOWCASE_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className="onboarding-showcase-card"
                        style={{ "--showcase-accent": opt.accent } as React.CSSProperties}
                        data-active={activeShowcase === opt.id}
                        onClick={() => handleShowcaseSelect(opt.id)}
                      >
                        <div className="onboarding-showcase-card-header">
                          <div className="onboarding-showcase-card-icon">
                            {ShowcaseIcons[opt.id]}
                          </div>
                          <span className="onboarding-showcase-card-category">{opt.category}</span>
                          <div className="onboarding-showcase-card-indicator" />
                        </div>
                        <div className="onboarding-showcase-card-title">{opt.label}</div>
                        <div className="onboarding-showcase-card-desc">{opt.description}</div>
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

              {/* ── Voice (Permission + Mic selection + Shortcut) ── */}
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

                          // Enumerate audio input devices now that permission is granted
                          const devices = await navigator.mediaDevices.enumerateDevices();
                          const mics = devices.filter((d) => d.kind === "audioinput" && d.deviceId);
                          setAudioInputDevices(mics);
                          // Auto-select the first device (system default)
                          if (mics.length > 0 && !selectedMicId) {
                            setSelectedMicId(mics[0].deviceId);
                          }
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

                  {/* Mic device picker — revealed after permission granted */}
                  <OnboardingReveal
                    visible={voicePermissionGranted === true && audioInputDevices.length > 1}
                    className="onboarding-mic-reveal"
                    innerClassName="onboarding-mic-reveal-inner"
                  >
                    <div className="onboarding-step-label">Microphone</div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className="onboarding-mic-trigger">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="23" />
                            <line x1="8" y1="23" x2="16" y2="23" />
                          </svg>
                          <span className="onboarding-mic-trigger-label">
                            {audioInputDevices.find((d) => d.deviceId === selectedMicId)?.label || "Select microphone"}
                          </span>
                          <svg className="onboarding-mic-trigger-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="bottom" align="start" sideOffset={6}>
                        {audioInputDevices.map((device, i) => (
                          <DropdownMenuItem
                            key={device.deviceId}
                            onClick={() => {
                              setSelectedMicId(device.deviceId);
                              localStorage.setItem(PREFERRED_MIC_KEY, device.deviceId);
                            }}
                          >
                            {selectedMicId === device.deviceId && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M5 12l5 5L20 7" />
                              </svg>
                            )}
                            {device.label || `Microphone ${i + 1}`}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </OnboardingReveal>

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
                      // Persist preferred microphone
                      if (selectedMicId) {
                        localStorage.setItem(PREFERRED_MIC_KEY, selectedMicId);
                      }
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
