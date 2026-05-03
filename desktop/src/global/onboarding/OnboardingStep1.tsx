import { useEffect, useMemo } from "react";
import type { DiscoveryCategory } from "@/shared/contracts/discovery";
import { SPLIT_PHASES, SPLIT_STEP_ORDER, type Phase } from "./onboarding-flow";
import { getPlatform } from "@/platform/electron/platform";
import { useOnboardingAppearance } from "./use-onboarding-appearance";
import { useOnboardingDiscovery } from "./use-onboarding-discovery";
import { useOnboardingFlow } from "./use-onboarding-flow";
import { useOnboardingMemory } from "./use-onboarding-memory";
import { useT } from "@/shared/i18n";
import "./Onboarding.css";

/* Phases are eager imports because the entire onboarding flow already
 * lives inside a single dynamically-imported "onboarding chunk" loaded
 * by FullShell when `!appReady` (see desktop/src/shell/FullShell.tsx).
 * Once that chunk has resolved, every phase module is in memory, so
 * splitting per-phase here would only re-introduce mid-flow Suspense
 * boundaries with no bundle-size win — and the original failure mode
 * was exactly that: the title would render against an empty
 * `.onboarding-split-stage` while the next phase's chunk loaded, the
 * Suspense fallback resolved with content, and the centered title
 * jumped upward. The split-stage layout is also pinned in
 * `Onboarding.css` so any future async content (data fetches, etc.)
 * can't reproduce the jump. */
import { OnboardingCapabilitiesPhase } from "./OnboardingCapabilitiesPhase";
import { OnboardingPermissions } from "./OnboardingPermissions";
import { OnboardingExtensionPhase } from "./OnboardingExtensionPhase";
import { OnboardingBrowserPhase } from "./OnboardingBrowserPhase";
import { OnboardingCreationPhase } from "./OnboardingCreationPhase";
import { OnboardingThemePhase } from "./OnboardingThemePhase";
import { OnboardingPersonalityPhase } from "./OnboardingPersonalityPhase";
import { OnboardingShortcutsPhase } from "./OnboardingShortcutsPhase";
import { OnboardingDoubleTapPhase } from "./OnboardingDoubleTapPhase";
import { OnboardingVoicePhase } from "./OnboardingVoicePhase";
import { OnboardingMemoryPhase } from "./OnboardingMemoryPhase";
import { OnboardingEnterPhase } from "./OnboardingEnterPhase";
import { OnboardingMockWindows } from "./OnboardingMockWindows";

/**
 * Translation keys for each split-phase title. The capabilities phase
 * renders its own per-scene title inside the phase body so the
 * changing line ("Text Stella from anywhere.", …) sits where the
 * static step title would otherwise be — that's why it's omitted here.
 */
const STEP_TITLE_KEYS: Partial<Record<Phase, string>> = {
  extension: "onboarding.stepTitles.extension",
  browser: "onboarding.stepTitles.browser",
  creation: "onboarding.stepTitles.creation",
  theme: "onboarding.stepTitles.theme",
  personality: "onboarding.stepTitles.personality",
  "shortcuts-global": "onboarding.stepTitles.shortcutsGlobal",
  "shortcuts-local": "onboarding.stepTitles.shortcutsLocal",
  "double-tap": "onboarding.stepTitles.doubleTap",
  voice: "onboarding.stepTitles.voice",
  memory: "onboarding.stepTitles.memory",
  enter: "onboarding.stepTitles.enter",
};

interface OnboardingStep1Props {
  onComplete: () => void;
  onInteract?: () => void;
  initialPhase?: Phase;
  onDiscoveryConfirm?: (categories: DiscoveryCategory[]) => void;
  onEnterSplit?: () => void;
  onDemoChange?: (demo: "default" | null) => void;
  onPhaseChange?: (phase: Phase) => void;
  onSelectionChange?: (hasSelections: boolean) => void;
  isAuthenticated?: boolean;
  discoveryWelcomeExpected?: boolean;
  discoveryWelcomeReady?: boolean;
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
  discoveryWelcomeExpected = false,
  discoveryWelcomeReady = false,
}: OnboardingStep1Props) => {
  const t = useT();
  const skippedPhases = useMemo(
    () => (discoveryWelcomeExpected ? undefined : new Set<Phase>(["enter"])),
    [discoveryWelcomeExpected],
  );
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
    skippedPhases,
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
      case "capabilities":
        return (
          <OnboardingCapabilitiesPhase
            splitTransitionActive={leaving}
            onContinue={nextSplitStep}
          />
        );
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
            isForcedTheme={appearance.isForcedTheme}
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
            personalityVoices={appearance.personalityVoices}
            personalityVoiceId={appearance.personalityVoiceId}
            defaultPersonalityVoiceId={appearance.defaultPersonalityVoiceId}
            splitTransitionActive={leaving}
            onFinish={nextSplitStep}
            onSelectVoice={appearance.selectPersonalityVoice}
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
      case "voice":
        return (
          <OnboardingVoicePhase
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
      case "enter":
        return (
          <OnboardingEnterPhase
            discoveryWelcomeReady={discoveryWelcomeReady}
            splitTransitionActive={leaving}
            onEnter={nextSplitStep}
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
              {t("onboarding.intro.primary")}
            </div>
            <div className="onboarding-text onboarding-text--fade-in-delayed">
              {t("onboarding.intro.secondary")}
            </div>
          </div>
          <div
            className="onboarding-choices onboarding-choices--subtle"
            data-visible={rippleActive}
          >
            <button className="onboarding-choice" onClick={continueIntro}>
              {t("common.continue")}
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
              {STEP_TITLE_KEYS[phase] ? (
                <div className="onboarding-split-title">
                  {t(STEP_TITLE_KEYS[phase] as string)}
                </div>
              ) : null}
              {renderActiveSplitPhase(phase)}
            </div>
          </div>

          <div className="onboarding-phase-nav">
            <button
              type="button"
              className="onboarding-phase-nav-btn onboarding-phase-nav-btn--prev"
              disabled={!canGoPrev || leaving}
              onClick={prevSplitStep}
              aria-label={t("onboarding.previousStep")}
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
              className="onboarding-phase-nav-btn onboarding-phase-nav-btn--next"
              disabled={!canGoNext || leaving}
              onClick={nextSplitStep}
              aria-label={t("onboarding.nextStep")}
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
