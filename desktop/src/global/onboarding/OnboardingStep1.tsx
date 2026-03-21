import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
  BROWSERS,
  DISCOVERY_CATEGORIES,
  SPLIT_PHASES,
  SPLIT_STEP_ORDER,
  type BrowserId,
  type OnboardingStep1Props,
  type Phase,
} from "./use-onboarding-state";
import type { OnboardingDemo } from "./OnboardingCanvas";
import { useTheme, useThemeControl } from "@/context/theme-context";
import { getPlatform } from "@/platform/electron/platform";
import { PREFERRED_MIC_KEY } from "@/features/voice/services/shared-microphone";
import type {
  ShowcaseId,
  ShowcaseOption,
} from "./OnboardingCreationPhase";
import "./Onboarding.css";
import "@/global/onboarding/selfmod-demo.css";

const loadBrowserPhase = () => import("./OnboardingBrowserPhase");
const loadCreationPhase = () => import("./OnboardingCreationPhase");
const loadVoicePhase = () => import("./OnboardingVoicePhase");
const loadThemePhase = () => import("./OnboardingThemePhase");
const loadPersonalityPhase = () => import("./OnboardingPersonalityPhase");
const loadMockWindows = () => import("./OnboardingMockWindows");

const OnboardingBrowserPhase = lazy(() =>
  loadBrowserPhase().then((module) => ({
    default: module.OnboardingBrowserPhase,
  })),
);
const OnboardingCreationPhase = lazy(() =>
  loadCreationPhase().then((module) => ({
    default: module.OnboardingCreationPhase,
  })),
);
const OnboardingVoicePhase = lazy(() =>
  loadVoicePhase().then((module) => ({
    default: module.OnboardingVoicePhase,
  })),
);
const OnboardingThemePhase = lazy(() =>
  loadThemePhase().then((module) => ({
    default: module.OnboardingThemePhase,
  })),
);
const OnboardingPersonalityPhase = lazy(() =>
  loadPersonalityPhase().then((module) => ({
    default: module.OnboardingPersonalityPhase,
  })),
);
const OnboardingMockWindows = lazy(() =>
  loadMockWindows().then((module) => ({
    default: module.OnboardingMockWindows,
  })),
);

const FADE_OUT_MS = 400;
const FADE_GAP_MS = 200;
const SPLIT_CROSSFADE_MS = 720;

const STEP_TITLES: Partial<Record<Phase, string>> = {
  browser: "Let me get to know you.",
  creation: "I'm not just a desktop app.",
  voice: "Speak your mind.",
  theme: "How should I look?",
  personality: "How should I talk?",
};

type CategoryStates = Record<DiscoveryCategory, boolean>;

const SHOWCASE_DEMO_BY_ID: Record<
  ShowcaseId,
  Exclude<OnboardingDemo, null | "default">
> = {
  modern: "modern",
  "cozy-cat": "cozy-cat",
  "dj-studio": "dj-studio",
  weather: "weather-station",
  pomodoro: "pomodoro",
};

const SHOWCASE_OPTIONS: ShowcaseOption[] = [
  {
    id: "modern",
    label: "Modernize the chat",
    description: "Glass panels, refined spacing, cool blue accents",
    category: "UI",
    accent: "oklch(0.6 0.18 250)",
    icon: (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    ),
  },
  {
    id: "cozy-cat",
    label: "Cozy cat theme",
    description: "Warm palette, playful cards, paw print decorations",
    category: "Theme",
    accent: "oklch(0.72 0.12 350)",
    icon: (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.08C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z" />
      </svg>
    ),
  },
  {
    id: "dj-studio",
    label: "Build a beat maker",
    description: "8-track step sequencer with real-time synthesis",
    category: "App",
    accent: "oklch(0.6 0.2 300)",
    icon: (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    ),
  },
  {
    id: "weather",
    label: "Weather dashboard",
    description: "Live forecasts, hourly charts, and smart insights",
    category: "Dashboard",
    accent: "oklch(0.65 0.15 200)",
    icon: (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
      </svg>
    ),
  },
  {
    id: "pomodoro",
    label: "Focus timer",
    description: "Pomodoro sessions with ambient soundscapes",
    category: "Tool",
    accent: "oklch(0.7 0.15 60)",
    icon: (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="13" r="8" />
        <path d="M12 9v4l2 2" />
        <path d="M5 3l2 2" />
        <path d="M19 3l-2 2" />
        <path d="M12 5V3" />
      </svg>
    ),
  },
];

const createDiscoveryCategoryStates = (): CategoryStates => {
  const initial = {} as CategoryStates;
  for (const category of DISCOVERY_CATEGORIES) {
    initial[category.id] = category.defaultEnabled;
  }
  return initial;
};

const getSelectedDiscoveryCategories = (states: CategoryStates) =>
  DISCOVERY_CATEGORIES.filter((category) => states[category.id]).map(
    (category) => category.id,
  );

const getFirstEnabledDiscoveryCategory = (states: CategoryStates) =>
  DISCOVERY_CATEGORIES.find((category) => states[category.id])?.id ?? null;

const getShowcaseDemo = (id: ShowcaseId | null): OnboardingDemo =>
  id === null ? "default" : SHOWCASE_DEMO_BY_ID[id];

const getNextPhaseToPrefetch = (phase: Phase): Phase | null => {
  switch (phase) {
    case "intro":
      return "browser";
    case "browser":
      return "creation";
    case "creation":
      return "voice";
    case "voice":
      return "theme";
    case "theme":
      return "personality";
    default:
      return null;
  }
};

const prefetchPhaseModule = (phase: Phase | null) => {
  switch (phase) {
    case "browser":
      void loadBrowserPhase();
      void loadMockWindows();
      break;
    case "creation":
      void loadCreationPhase();
      break;
    case "voice":
      void loadVoicePhase();
      break;
    case "theme":
      void loadThemePhase();
      break;
    case "personality":
      void loadPersonalityPhase();
      break;
    default:
      break;
  }
};

const splitPhaseFallback = (
  <div className="onboarding-step-content" aria-busy="true" />
);

export const OnboardingStep1 = ({
  initialPhase = "start",
  onComplete,
  onAccept,
  onInteract,
  onDiscoveryConfirm,
  onEnterSplit,
  onSelectionChange,
  onDemoChange,
  demoMorphing,
  isAuthenticated,
}: OnboardingStep1Props) => {
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [leaving, setLeaving] = useState(false);
  const [rippleActive, setRippleActive] = useState(initialPhase === "intro");
  const [outgoingSplitPhase, setOutgoingSplitPhase] = useState<Phase | null>(
    null,
  );
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const [audioInputDevices, setAudioInputDevices] = useState<
    MediaDeviceInfo[]
  >([]);
  const [selectedMicId, setSelectedMicId] = useState<string | null>(null);
  const [categoryStates, setCategoryStates] = useState<CategoryStates>(
    createDiscoveryCategoryStates,
  );
  const [expressionStyle, setExpressionStyle] = useState<
    "emotes" | "emoji" | "none" | null
  >(null);
  const [activeShowcase, setActiveShowcase] = useState<ShowcaseId | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  const saveExpressionStyle = useMutation(
    api.data.preferences.setExpressionStyle,
  );
  const savePreferredBrowser = useMutation(
    api.data.preferences.setPreferredBrowser,
  );

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

  useEffect(() => {
    const hasAny =
      Object.values(categoryStates).some((value) => value) || browserEnabled;
    onSelectionChange?.(hasAny);
  }, [browserEnabled, categoryStates, onSelectionChange]);

  useEffect(() => {
    const shell = document.querySelector(".window-shell");
    if (!shell) {
      return;
    }

    shell.setAttribute("data-onboarding", "");
    return () => {
      shell.removeAttribute("data-onboarding");
    };
  }, []);

  useEffect(() => {
    if (phase === "creation" && !leaving) {
      onDemoChange?.("default");
    } else {
      onDemoChange?.(null);
      setActiveShowcase(null);
    }
  }, [leaving, onDemoChange, phase]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => {
      setPrefersReducedMotion(mediaQuery.matches);
    };

    updatePreference();
    mediaQuery.addEventListener?.("change", updatePreference);
    mediaQuery.addListener?.(updatePreference);

    return () => {
      mediaQuery.removeEventListener?.("change", updatePreference);
      mediaQuery.removeListener?.(updatePreference);
    };
  }, []);

  useEffect(() => {
    prefetchPhaseModule(getNextPhaseToPrefetch(phase));
  }, [phase]);

  const transitionTo = useCallback(
    (next: Phase) => {
      clearTimeoutRef();
      const isSplitToSplit =
        SPLIT_PHASES.has(phase) && SPLIT_PHASES.has(next) && phase !== next;

      if (isSplitToSplit) {
        setLeaving(false);
        setOutgoingSplitPhase(prefersReducedMotion ? null : phase);
        setPhase(next);

        if (prefersReducedMotion) {
          return;
        }

        timeoutRef.current = setTimeout(() => {
          setOutgoingSplitPhase(null);
          timeoutRef.current = null;
        }, SPLIT_CROSSFADE_MS);
        return;
      }

      setOutgoingSplitPhase(null);

      if (prefersReducedMotion) {
        setLeaving(false);
        setPhase(next);
        return;
      }

      setLeaving(true);
      timeoutRef.current = setTimeout(() => {
        setLeaving(false);
        setPhase(next);
        timeoutRef.current = null;
      }, FADE_OUT_MS + FADE_GAP_MS);
    },
    [clearTimeoutRef, phase, prefersReducedMotion],
  );

  const handleStart = useCallback(() => {
    clearTimeoutRef();
    setLeaving(true);
    onAccept?.();
    onInteract?.();
    timeoutRef.current = setTimeout(() => {
      setLeaving(false);
      setPhase("intro");
    }, 1600);
  }, [clearTimeoutRef, onAccept, onInteract]);

  useEffect(() => {
    if (phase !== "intro") {
      return;
    }

    const timeoutId = setTimeout(() => {
      setRippleActive(true);
    }, 400);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [phase]);

  useEffect(() => {
    if (!browserEnabled || detectedBrowser) {
      return;
    }

    let cancelled = false;

    const detectBrowser = async () => {
      try {
        const detected = await window.electronAPI?.browser.detectPreferred?.();
        if (cancelled || !detected?.browser) {
          return;
        }

        const supportedBrowserIds = new Set(
          BROWSERS.map((browser) => browser.id),
        );
        const detectedId = detected.browser as BrowserId;
        if (!supportedBrowserIds.has(detectedId)) {
          return;
        }

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

  useEffect(() => {
    if (!selectedBrowser) {
      return;
    }

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

  useEffect(() => {
    if (phase === "complete") {
      clearTimeoutRef();
      timeoutRef.current = setTimeout(() => {
        setPhase("done");
        onComplete();
      }, 600);
    }

    return clearTimeoutRef;
  }, [clearTimeoutRef, onComplete, phase]);

  useEffect(() => clearTimeoutRef, [clearTimeoutRef]);

  const nextSplitStep = useCallback(() => {
    const index = SPLIT_STEP_ORDER.indexOf(phase);
    if (index < SPLIT_STEP_ORDER.length - 1) {
      onInteract?.();
      transitionTo(SPLIT_STEP_ORDER[index + 1]);
      return;
    }

    onInteract?.();
    transitionTo("complete");
  }, [onInteract, phase, transitionTo]);

  const prevSplitStep = useCallback(() => {
    const index = SPLIT_STEP_ORDER.indexOf(phase);
    if (index > 0) {
      onInteract?.();
      transitionTo(SPLIT_STEP_ORDER[index - 1]);
    }
  }, [onInteract, phase, transitionTo]);

  const handleIntroContinue = useCallback(() => {
    onInteract?.();
    onEnterSplit?.();
    transitionTo("browser");
  }, [onEnterSplit, onInteract, transitionTo]);

  const handleShowcaseSelect = useCallback(
    (id: ShowcaseId) => {
      if (demoMorphing) {
        return;
      }

      const nextShowcase = activeShowcase === id ? null : id;
      setActiveShowcase(nextShowcase);
      onDemoChange?.(getShowcaseDemo(nextShowcase));
    },
    [activeShowcase, demoMorphing, onDemoChange],
  );

  const handleDiscoveryConfirm = useCallback(() => {
    const selected = getSelectedDiscoveryCategories(categoryStates);
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
  }, [
    browserEnabled,
    categoryStates,
    isAuthenticated,
    nextSplitStep,
    onDiscoveryConfirm,
    savePreferredBrowser,
    selectedBrowser,
    selectedProfile,
    showNoneWarning,
  ]);

  const handleToggleCategory = useCallback(
    (id: DiscoveryCategory) => {
      const wasEnabled = categoryStates[id];
      const nextCategoryStates = { ...categoryStates, [id]: !wasEnabled };
      setCategoryStates(nextCategoryStates);
      setShowNoneWarning(false);

      if (!wasEnabled) {
        setActiveMockId(id);
      } else if (activeMockId === id) {
        setActiveMockId(
          browserEnabled
            ? "browser"
            : getFirstEnabledDiscoveryCategory(nextCategoryStates),
        );
      }
    },
    [activeMockId, browserEnabled, categoryStates],
  );

  const handleToggleBrowser = useCallback(() => {
    const wasEnabled = browserEnabled;
    setBrowserEnabled((current) => !current);
    setShowNoneWarning(false);

    if (wasEnabled) {
      setSelectedBrowser(null);
      setDetectedBrowser(null);
      setAvailableProfiles([]);
      setSelectedProfile(null);
      if (activeMockId === "browser") {
        setActiveMockId(getFirstEnabledDiscoveryCategory(categoryStates));
      }
      return;
    }

    setActiveMockId("browser");
  }, [activeMockId, browserEnabled, categoryStates]);

  const handleSelectBrowser = useCallback((browserId: BrowserId) => {
    setAvailableProfiles([]);
    setSelectedProfile(null);
    setSelectedBrowser(browserId);
  }, []);

  const handleRequestMicrophone = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      stream.getTracks().forEach((track) => track.stop());
      setVoicePermissionGranted(true);

      const devices = await navigator.mediaDevices.enumerateDevices();
      const microphones = devices.filter(
        (device) => device.kind === "audioinput" && device.deviceId,
      );
      setAudioInputDevices(microphones);
      if (microphones.length > 0 && !selectedMicId) {
        setSelectedMicId(microphones[0].deviceId);
      }
    } catch {
      setVoicePermissionGranted(false);
    }
  }, [selectedMicId]);

  const handleVoiceContinue = useCallback(() => {
    if (selectedMicId) {
      localStorage.setItem(PREFERRED_MIC_KEY, selectedMicId);
    }

    const finalShortcut = "CommandOrControl+Shift+V";
    localStorage.setItem("stella-voice-shortcut", finalShortcut);
    void window.electronAPI?.voice
      .setShortcut?.(finalShortcut)
      .then((result) => {
        if (!result || result.activeShortcut === finalShortcut) {
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
  }, [nextSplitStep, selectedMicId]);

  const handleThemeSelect = useCallback(
    (id: string) => {
      setTheme(id);
      cancelPreview();
    },
    [cancelPreview, setTheme],
  );

  const handleExpressionStyleSelect = useCallback(
    (style: "emotes" | "emoji" | "none") => {
      setExpressionStyle(style);
      const backendStyle = style === "none" ? "none" : "emoji";
      if (isAuthenticated) {
        void saveExpressionStyle({ style: backendStyle }).catch(() => {
          // Expression style sync is best-effort only.
        });
      }
    },
    [isAuthenticated, saveExpressionStyle],
  );

  if (phase === "done") {
    return null;
  }

  const isSplit = SPLIT_PHASES.has(phase);
  const isComplete = phase === "complete";
  const splitStepIndex = SPLIT_STEP_ORDER.indexOf(phase);
  const canGoPrev = splitStepIndex > 0;
  const canGoNext = splitStepIndex < SPLIT_STEP_ORDER.length - 1;
  const platform = getPlatform();
  const splitTransitionActive = outgoingSplitPhase !== null;
  const sortedThemes = [...themes].sort((a, b) => a.name.localeCompare(b.name));

  const renderActiveSplitPhase = (activePhase: Phase) => {
    switch (activePhase) {
      case "browser":
        return (
          <Suspense fallback={splitPhaseFallback}>
            <OnboardingBrowserPhase
              availableProfiles={availableProfiles}
              browserEnabled={browserEnabled}
              categoryStates={categoryStates}
              platform={platform}
              selectedBrowser={selectedBrowser}
              selectedProfile={selectedProfile}
              showNoneWarning={showNoneWarning}
              splitTransitionActive={splitTransitionActive}
              onContinue={handleDiscoveryConfirm}
              onSelectBrowser={handleSelectBrowser}
              onSelectProfile={setSelectedProfile}
              onToggleBrowser={handleToggleBrowser}
              onToggleCategory={handleToggleCategory}
            />
          </Suspense>
        );
      case "creation":
        return (
          <Suspense fallback={splitPhaseFallback}>
            <OnboardingCreationPhase
              activeShowcase={activeShowcase}
              demoMorphing={demoMorphing}
              showcaseOptions={SHOWCASE_OPTIONS}
              splitTransitionActive={splitTransitionActive}
              onContinue={nextSplitStep}
              onSelectShowcase={handleShowcaseSelect}
            />
          </Suspense>
        );
      case "voice":
        return (
          <Suspense fallback={splitPhaseFallback}>
            <OnboardingVoicePhase
              audioInputDevices={audioInputDevices}
              platform={platform}
              selectedMicId={selectedMicId}
              splitTransitionActive={splitTransitionActive}
              voicePermissionGranted={voicePermissionGranted}
              onContinue={handleVoiceContinue}
              onRequestMicrophone={() => {
                void handleRequestMicrophone();
              }}
              onSelectMic={setSelectedMicId}
            />
          </Suspense>
        );
      case "theme":
        return (
          <Suspense fallback={splitPhaseFallback}>
            <OnboardingThemePhase
              colorMode={colorMode}
              gradientColor={gradientColor}
              gradientMode={gradientMode}
              sortedThemes={sortedThemes}
              splitTransitionActive={splitTransitionActive}
              themeId={themeId}
              onContinue={nextSplitStep}
              onSelectColorMode={setColorMode}
              onSelectGradientColor={setGradientColor}
              onSelectGradientMode={setGradientMode}
              onSelectTheme={handleThemeSelect}
              onThemePreviewEnter={previewTheme}
              onThemePreviewLeave={cancelThemePreview}
            />
          </Suspense>
        );
      case "personality":
        return (
          <Suspense fallback={splitPhaseFallback}>
            <OnboardingPersonalityPhase
              expressionStyle={expressionStyle}
              splitTransitionActive={splitTransitionActive}
              onFinish={nextSplitStep}
              onSelectStyle={handleExpressionStyleSelect}
            />
          </Suspense>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className={`onboarding-dialogue ${isSplit ? "onboarding-dialogue--split" : ""}`}
      data-phase={phase}
      data-leaving={leaving}
      style={{ display: isComplete ? "none" : undefined }}
    >
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

      {isSplit && (
        <>
          {phase === "browser" ? (
            <Suspense fallback={null}>
              <OnboardingMockWindows
                activeWindowId={activeMockId}
                stageState="current"
              />
            </Suspense>
          ) : null}
          {outgoingSplitPhase === "browser" ? (
            <Suspense fallback={null}>
              <OnboardingMockWindows
                activeWindowId={activeMockId}
                stageState="outgoing"
              />
            </Suspense>
          ) : null}

          <div className="onboarding-split-right">
            <div
              className="onboarding-split-stage"
              data-phase={phase}
              key={phase}
            >
              {STEP_TITLES[phase] ? (
                <div className="onboarding-split-title">
                  {STEP_TITLES[phase]}
                </div>
              ) : null}
              {renderActiveSplitPhase(phase)}
            </div>
          </div>

          <div className="onboarding-phase-nav">
            <button
              type="button"
              className="onboarding-phase-nav-btn"
              disabled={!canGoPrev || outgoingSplitPhase !== null}
              onClick={prevSplitStep}
              aria-label="Previous step"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <button
              type="button"
              className="onboarding-phase-nav-btn"
              disabled={!canGoNext || outgoingSplitPhase !== null}
              onClick={nextSplitStep}
              aria-label="Next step"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>
        </>
      )}
    </div>
  );
};
