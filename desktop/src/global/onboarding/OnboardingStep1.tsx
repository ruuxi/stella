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
  readVisualPrefs,
  writeVisualPrefs,
} from "@/shared/contracts/visual-prefs";
import {
  BROWSERS,
  DISCOVERY_CATEGORIES,
  SPLIT_PHASES,
  SPLIT_STEP_ORDER,
  type BrowserId,
  type OnboardingStep1Props,
  type Phase,
} from "./use-onboarding-state";
import { useTheme, useThemeControl } from "@/context/theme-context";
import { getPlatform } from "@/platform/electron/platform";
import { markRequestSignInAfterOnboarding } from "@/shared/lib/stella-orb-chat";
import "./Onboarding.css";
import "@/global/onboarding/selfmod-demo.css";

const loadPermissionsPhase = () => import("./OnboardingPermissions");
const loadBrowserPhase = () => import("./OnboardingBrowserPhase");
const loadCreationPhase = () => import("./OnboardingCreationPhase");
const loadThemePhase = () => import("./OnboardingThemePhase");
const loadPersonalityPhase = () => import("./OnboardingPersonalityPhase");
const loadShortcutsPhase = () => import("./OnboardingShortcutsPhase");
const loadDoubleTapPhase = () => import("./OnboardingDoubleTapPhase");
const loadMemoryPhase = () => import("./OnboardingMemoryPhase");
const loadMockWindows = () => import("./OnboardingMockWindows");

const OnboardingPermissions = lazy(() =>
  loadPermissionsPhase().then((module) => ({
    default: module.OnboardingPermissions,
  })),
);
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
const OnboardingShortcutsPhase = lazy(() =>
  loadShortcutsPhase().then((module) => ({
    default: module.OnboardingShortcutsPhase,
  })),
);
const OnboardingDoubleTapPhase = lazy(() =>
  loadDoubleTapPhase().then((module) => ({
    default: module.OnboardingDoubleTapPhase,
  })),
);
const OnboardingMemoryPhase = lazy(() =>
  loadMemoryPhase().then((module) => ({
    default: module.OnboardingMemoryPhase,
  })),
);
const OnboardingMockWindows = lazy(() =>
  loadMockWindows().then((module) => ({
    default: module.OnboardingMockWindows,
  })),
);

const FADE_OUT_MS = 260;
const FADE_GAP_MS = 120;
const INTRO_CONTINUE_DELAY_MS = 1100;

const STEP_TITLES: Partial<Record<Phase, string>> = {
  browser: "Let me get to know you.",
  creation: "I can change myself.",
  theme: "How should I look?",
  personality: "How should I talk?",
  "shortcuts-global": "Anywhere on your desktop.",
  "shortcuts-local": "Inside Stella.",
  "double-tap": "Tap twice. Summon Stella.",
  memory: "Help me remember.",
};

type CategoryStates = Record<DiscoveryCategory, boolean>;

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

const getNextPhaseToPrefetch = (phase: Phase): Phase | null => {
  switch (phase) {
    case "intro":
      return "permissions";
    case "permissions":
      return "browser";
    case "browser":
      return "theme";
    case "theme":
      return "personality";
    case "personality":
      return "creation";
    case "creation":
      return "shortcuts-global";
    case "shortcuts-global":
      return "shortcuts-local";
    case "shortcuts-local":
      return "double-tap";
    case "double-tap":
      return "memory";
    default:
      return null;
  }
};

const prefetchPhaseModule = (phase: Phase | null) => {
  switch (phase) {
    case "permissions":
      void loadPermissionsPhase();
      break;
    case "browser":
      void loadBrowserPhase();
      void loadMockWindows();
      break;
    case "creation":
      void loadCreationPhase();
      break;
    case "theme":
      void loadThemePhase();
      break;
    case "personality":
      void loadPersonalityPhase();
      break;
    case "shortcuts-global":
    case "shortcuts-local":
      void loadShortcutsPhase();
      break;
    case "double-tap":
      void loadDoubleTapPhase();
      break;
    case "memory":
      void loadMemoryPhase();
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
  isAuthenticated,
}: OnboardingStep1Props) => {
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [leaving, setLeaving] = useState(false);
  const [rippleActive, setRippleActive] = useState(initialPhase === "intro");
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
  const [categoryStates, setCategoryStates] = useState<CategoryStates>(
    createDiscoveryCategoryStates,
  );
  const [expressionStyle, setExpressionStyle] = useState<
    "emotes" | "emoji" | "none" | null
  >(null);
  const [visualPrefs, setVisualPrefs] = useState(() => readVisualPrefs());
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
    /* Mock windows (and creature shift) only exist on browser step; clear flag when leaving */
    onSelectionChange?.(phase === "browser" && hasAny);
  }, [browserEnabled, categoryStates, onSelectionChange, phase]);

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
    }, INTRO_CONTINUE_DELAY_MS);

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
        const detected =
          await window.electronAPI?.discovery.detectPreferred?.();
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
          await window.electronAPI?.discovery.listProfiles?.(selectedBrowser);
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
      setPhase("done");
      onComplete();
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
    transitionTo("permissions");
  }, [onEnterSplit, onInteract, transitionTo]);

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

  const handleToggleEyes = useCallback(() => {
    setVisualPrefs((current) => {
      const next = { ...current, showEyes: !current.showEyes };
      writeVisualPrefs(next);
      return next;
    });
  }, []);

  const handleToggleMouth = useCallback(() => {
    setVisualPrefs((current) => {
      const next = { ...current, showMouth: !current.showMouth };
      writeVisualPrefs(next);
      return next;
    });
  }, []);

  const handleMemoryContinue = useCallback(
    ({
      memoryEnabled,
      requestSignIn,
    }: {
      memoryEnabled: boolean;
      requestSignIn: boolean;
    }) => {
      // Persist the user's choice via the unified memory IPC. The handler
      // takes care of keeping Chronicle + Dream in lockstep, and stages
      // a `pendingEnable` when we don't yet have an auth session — so
      // nothing actually starts until the user signs in.
      const api = window.electronAPI?.memory;
      if (memoryEnabled) {
        if (requestSignIn) {
          markRequestSignInAfterOnboarding();
        }
        void api?.setEnabled(true, { pending: requestSignIn }).catch(() => {
          // Best-effort: a failure here just means the daemon stays off.
          // The user can re-toggle from Settings.
        });
      } else {
        void api?.setEnabled(false).catch(() => {
          // Best-effort.
        });
      }
      nextSplitStep();
    },
    [nextSplitStep],
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
  const sortedThemes = [...themes].sort((a, b) => a.name.localeCompare(b.name));

  const renderActiveSplitPhase = (activePhase: Phase) => {
    switch (activePhase) {
      case "permissions":
        return (
          <Suspense fallback={splitPhaseFallback}>
            <OnboardingPermissions
              splitTransitionActive={leaving}
              onContinue={nextSplitStep}
            />
          </Suspense>
        );
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
              splitTransitionActive={leaving}
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
              splitTransitionActive={leaving}
              onContinue={nextSplitStep}
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
              splitTransitionActive={leaving}
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
              splitTransitionActive={leaving}
              showEyes={visualPrefs.showEyes}
              showMouth={visualPrefs.showMouth}
              onFinish={nextSplitStep}
              onSelectStyle={handleExpressionStyleSelect}
              onToggleEyes={handleToggleEyes}
              onToggleMouth={handleToggleMouth}
            />
          </Suspense>
        );
      case "shortcuts-global":
        return (
          <Suspense fallback={splitPhaseFallback}>
            <OnboardingShortcutsPhase
              mode="global"
              splitTransitionActive={leaving}
              onFinish={nextSplitStep}
            />
          </Suspense>
        );
      case "shortcuts-local":
        return (
          <Suspense fallback={splitPhaseFallback}>
            <OnboardingShortcutsPhase
              mode="local"
              splitTransitionActive={leaving}
              onFinish={nextSplitStep}
            />
          </Suspense>
        );
      case "double-tap":
        return (
          <Suspense fallback={splitPhaseFallback}>
            <OnboardingDoubleTapPhase
              splitTransitionActive={leaving}
              onContinue={nextSplitStep}
            />
          </Suspense>
        );
      case "memory":
        return (
          <Suspense fallback={splitPhaseFallback}>
            <OnboardingMemoryPhase
              splitTransitionActive={leaving}
              isAuthenticated={Boolean(isAuthenticated)}
              onContinue={handleMemoryContinue}
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
              I'm an AI that runs on your computer.
            </div>
            <div className="onboarding-text onboarding-text--fade-in-delayed">
              I'm not made for everyone. I'm made for you.
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
              disabled={!canGoPrev || leaving}
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
              disabled={!canGoNext || leaving}
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
