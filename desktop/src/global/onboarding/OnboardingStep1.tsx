import { useCallback, useEffect, useRef, useState } from "react";
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
  type Phase,
} from "./onboarding-flow";
import { useTheme, useThemeControl } from "@/context/theme-context";
import { getPlatform } from "@/platform/electron/platform";
import { markRequestSignInAfterOnboarding } from "@/shared/lib/stella-orb-chat";
import "./Onboarding.css";

/* These phases used to be lazy-loaded, which caused a visible layout
 * shift on entry: the title would render first inside an empty
 * `.onboarding-split-stage` (the Suspense fallback was just an empty
 * `.onboarding-step-content` div), so it sat lower in the
 * vertically-centered split-right pane, then the lazy chunk would
 * resolve, the pills/cards would mount, and the title would jump
 * upward. Onboarding is a one-time flow with the user already on a
 * loading-style intro, so the bundle savings aren't worth the visual
 * jolt — eager imports keep the disclosure as one block. */
import { OnboardingPermissions } from "./OnboardingPermissions";
import { OnboardingBrowserPhase } from "./OnboardingBrowserPhase";
import { OnboardingCreationPhase } from "./OnboardingCreationPhase";
import { OnboardingThemePhase } from "./OnboardingThemePhase";
import { OnboardingPersonalityPhase } from "./OnboardingPersonalityPhase";
import { OnboardingShortcutsPhase } from "./OnboardingShortcutsPhase";
import { OnboardingDoubleTapPhase } from "./OnboardingDoubleTapPhase";
import { OnboardingMemoryPhase } from "./OnboardingMemoryPhase";
import { OnboardingMockWindows } from "./OnboardingMockWindows";

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

export interface OnboardingStep1Props {
  onComplete: () => void;
  onInteract?: () => void;
  initialPhase?: Phase;
  onDiscoveryConfirm?: (categories: DiscoveryCategory[]) => void;
  onEnterSplit?: () => void;
  onDemoChange?: (demo: "default" | null) => void;
  onPhaseChange?: (phase: Phase) => void;
  onSelectionChange?: (hasSelections: boolean) => void;
  isAuthenticated?: boolean;
}

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

export const OnboardingStep1 = ({
  initialPhase = "intro",
  onComplete,
  onInteract,
  onDiscoveryConfirm,
  onEnterSplit,
  onSelectionChange,
  onDemoChange,
  onPhaseChange,
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
  >("none");
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
    onPhaseChange?.(phase);
  }, [onPhaseChange, phase]);

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
          <OnboardingPermissions
            splitTransitionActive={leaving}
            onContinue={nextSplitStep}
          />
        );
      case "browser":
        return (
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
        );
      case "creation":
        return (
          <OnboardingCreationPhase
            splitTransitionActive={leaving}
            onContinue={nextSplitStep}
          />
        );
      case "theme":
        return (
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
        );
      case "personality":
        return (
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
        );
      case "shortcuts-global":
        return (
          <OnboardingShortcutsPhase
            mode="global"
            splitTransitionActive={leaving}
            onFinish={nextSplitStep}
          />
        );
      case "shortcuts-local":
        return (
          <OnboardingShortcutsPhase
            mode="local"
            splitTransitionActive={leaving}
            onFinish={nextSplitStep}
          />
        );
      case "double-tap":
        return (
          <OnboardingDoubleTapPhase
            splitTransitionActive={leaving}
            onContinue={nextSplitStep}
          />
        );
      case "memory":
        return (
          <OnboardingMemoryPhase
            splitTransitionActive={leaving}
            isAuthenticated={Boolean(isAuthenticated)}
            onContinue={handleMemoryContinue}
          />
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
            <OnboardingMockWindows
              activeWindowId={activeMockId}
              stageState="current"
            />
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
