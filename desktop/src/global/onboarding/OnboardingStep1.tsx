import { useEffect } from "react";
import type { DiscoveryCategory } from "@/shared/contracts/discovery";
import { SPLIT_PHASES, SPLIT_STEP_ORDER, type Phase } from "./onboarding-flow";
import { getPlatform } from "@/platform/electron/platform";
import { useOnboardingAppearance } from "./use-onboarding-appearance";
import { useOnboardingDiscovery } from "./use-onboarding-discovery";
import { useOnboardingFlow } from "./use-onboarding-flow";
import { useOnboardingMemory } from "./use-onboarding-memory";
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
import { OnboardingExtensionPhase } from "./OnboardingExtensionPhase";
import { OnboardingBrowserPhase } from "./OnboardingBrowserPhase";
import { OnboardingCreationPhase } from "./OnboardingCreationPhase";
import { OnboardingThemePhase } from "./OnboardingThemePhase";
import { OnboardingPersonalityPhase } from "./OnboardingPersonalityPhase";
import { OnboardingShortcutsPhase } from "./OnboardingShortcutsPhase";
import { OnboardingDoubleTapPhase } from "./OnboardingDoubleTapPhase";
import { OnboardingMemoryPhase } from "./OnboardingMemoryPhase";
import { OnboardingMockWindows } from "./OnboardingMockWindows";

const STEP_TITLES: Partial<Record<Phase, string>> = {
  extension: "Add Stella to your browser.",
  browser: "Let Stella get to know you.",
  creation: "Stella can change.",
  theme: "How should Stella look?",
  personality: "How should Stella talk?",
  "shortcuts-global": "Anywhere on your desktop.",
  "shortcuts-local": "Inside Stella.",
  "double-tap": "Tap twice. Summon Stella.",
  memory: "Help Stella remember.",
};

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
  const {
    phase,
    leaving,
    rippleActive,
    nextSplitStep,
    prevSplitStep,
    continueIntro,
  } = useOnboardingFlow({
    initialPhase,
    onComplete,
    onEnterSplit,
    onInteract,
    onPhaseChange,
  });

  const discovery = useOnboardingDiscovery({
    isAuthenticated,
    nextSplitStep,
    onDiscoveryConfirm,
    onSelectionChange,
    phase,
  });

  const appearance = useOnboardingAppearance({ isAuthenticated });
  const handleMemoryContinue = useOnboardingMemory(nextSplitStep);

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

  if (phase === "done") {
    return null;
  }

  const isSplit = SPLIT_PHASES.has(phase);
  const isComplete = phase === "complete";
  const splitStepIndex = SPLIT_STEP_ORDER.indexOf(phase);
  const canGoPrev = splitStepIndex > 0;
  const canGoNext = splitStepIndex < SPLIT_STEP_ORDER.length - 1;
  const platform = getPlatform();

  const renderActiveSplitPhase = (activePhase: Phase) => {
    switch (activePhase) {
      case "permissions":
        return (
          <OnboardingPermissions
            splitTransitionActive={leaving}
            onContinue={nextSplitStep}
          />
        );
      case "extension":
        return (
          <OnboardingExtensionPhase
            splitTransitionActive={leaving}
            onContinue={nextSplitStep}
          />
        );
      case "browser":
        return (
          <OnboardingBrowserPhase
            availableProfiles={discovery.availableProfiles}
            browserEnabled={discovery.browserEnabled}
            categoryStates={discovery.categoryStates}
            platform={platform}
            selectedBrowser={discovery.selectedBrowser}
            selectedProfile={discovery.selectedProfile}
            showNoneWarning={discovery.showNoneWarning}
            splitTransitionActive={leaving}
            onContinue={discovery.confirmDiscovery}
            onSelectBrowser={discovery.selectBrowser}
            onSelectProfile={discovery.setSelectedProfile}
            onToggleBrowser={discovery.toggleBrowser}
            onToggleCategory={discovery.toggleCategory}
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
            colorMode={appearance.colorMode}
            gradientColor={appearance.gradientColor}
            gradientMode={appearance.gradientMode}
            sortedThemes={appearance.sortedThemes}
            splitTransitionActive={leaving}
            themeId={appearance.themeId}
            onContinue={nextSplitStep}
            onSelectColorMode={appearance.setColorMode}
            onSelectGradientColor={appearance.setGradientColor}
            onSelectGradientMode={appearance.setGradientMode}
            onSelectTheme={appearance.selectTheme}
            onThemePreviewEnter={appearance.previewTheme}
            onThemePreviewLeave={appearance.cancelThemePreview}
          />
        );
      case "personality":
        return (
          <OnboardingPersonalityPhase
            expressionStyle={appearance.expressionStyle}
            splitTransitionActive={leaving}
            showEyes={appearance.showEyes}
            showMouth={appearance.showMouth}
            onFinish={nextSplitStep}
            onSelectStyle={appearance.selectExpressionStyle}
            onToggleEyes={appearance.toggleEyes}
            onToggleMouth={appearance.toggleMouth}
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
              Stella is an AI that runs on your computer.
            </div>
            <div className="onboarding-text onboarding-text--fade-in-delayed">
              Stella isn't for everyone. Stella is for you.
            </div>
          </div>
          <div
            className="onboarding-choices onboarding-choices--subtle"
            data-visible={rippleActive}
          >
            <button className="onboarding-choice" onClick={continueIntro}>
              Continue
            </button>
          </div>
        </div>
      )}

      {isSplit && (
        <>
          {phase === "browser" ? (
            <OnboardingMockWindows
              activeWindowId={discovery.activeMockId}
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
