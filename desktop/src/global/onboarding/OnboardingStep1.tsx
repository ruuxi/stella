import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "@/ui/icons";
import type { DiscoveryCategory } from "../../../../runtime/contracts/discovery.js";
import {
  PHASE_ACTS,
  SPLIT_PHASES,
  SPLIT_STEP_ORDER,
  type OnboardingAct,
  type Phase,
} from "./onboarding-flow";
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
import { OnboardingShapeshiftPhase } from "./OnboardingShapeshiftPhase";
import { OnboardingMigrationPhase } from "./OnboardingMigrationPhase";
import { OnboardingEnginePhase } from "./OnboardingEnginePhase";
import { OnboardingPermissions } from "./OnboardingPermissions";
import { OnboardingExtensionPhase } from "./OnboardingExtensionPhase";
import { OnboardingBrowserPhase } from "./OnboardingBrowserPhase";
import { OnboardingThemePhase } from "./OnboardingThemePhase";
import { OnboardingPersonalityPhase } from "./OnboardingPersonalityPhase";
import { OnboardingSummonPhase } from "./OnboardingSummonPhase";
import { OnboardingVoicePhase } from "./OnboardingVoicePhase";
import { OnboardingMemoryPhase } from "./OnboardingMemoryPhase";
import { OnboardingEnterPhase } from "./OnboardingEnterPhase";
import { OnboardingMockWindows } from "./OnboardingMockWindows";

/**
 * Translation keys for each split-phase title. The capabilities phase
 * renders its own per-chapter title inside the phase body so the
 * changing line sits where the static step title would otherwise be —
 * that's why it's omitted here.
 */
const STEP_TITLE_KEYS: Partial<Record<Phase, string>> = {
  shapeshift: "onboarding.stepTitles.shapeshift",
  engine: "onboarding.stepTitles.engine",
  extension: "onboarding.stepTitles.extension",
  browser: "onboarding.stepTitles.browser",
  theme: "onboarding.stepTitles.theme",
  personality: "onboarding.stepTitles.personality",
  summon: "onboarding.stepTitles.summon",
  voice: "onboarding.stepTitles.voice",
  memory: "onboarding.stepTitles.memory",
  import: "onboarding.stepTitles.import",
  enter: "onboarding.stepTitles.enter",
};

const ACT_LABEL_KEYS: Record<OnboardingAct, string> = {
  discover: "onboarding.acts.discover",
  personalize: "onboarding.acts.personalize",
  connect: "onboarding.acts.connect",
  flow: "onboarding.acts.flow",
  ready: "onboarding.acts.ready",
};

interface OnboardingStep1Props {
  onComplete: () => void;
  onInteract?: () => void;
  initialPhase?: Phase;
  onDiscoveryConfirm?: (categories: DiscoveryCategory[]) => void;
  onEnterSplit?: () => void;
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
  onPhaseChange,
  isAuthenticated,
  discoveryWelcomeExpected = false,
  discoveryWelcomeReady = false,
}: OnboardingStep1Props) => {
  const t = useT();

  // The engine phase (Stella / Claude Code / BYOK provider) is only useful
  // for users who already run other AI dev tooling. Detection is a one-shot
  // filesystem probe in the main process — see
  // `system:detectTechnicalUserSignals` — and defaults to "skip" until
  // resolved so non-technical users never even see the phase. Detection
  // completes in milliseconds, long before navigation can reach `engine`.
  const [showEnginePhase, setShowEnginePhase] = useState(false);
  const [showMigrationPhase, setShowMigrationPhase] = useState(false);
  const [migrationDetectionResolved, setMigrationDetectionResolved] =
    useState(false);
  // When a personality is imported from another tool, its file becomes
  // ~/.stella/PERSONALITY.md. Skip the personality-selection phase so the
  // onboarding picker doesn't overwrite the imported personality.
  const [personalityImported, setPersonalityImported] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const result =
          await window.electronAPI?.system?.detectTechnicalUserSignals?.();
        if (cancelled) return;
        setShowEnginePhase(Boolean(result?.signals?.length));
      } catch {
        // Best-effort; default-to-skip stays in effect on failure.
      }
    };
    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const result = await window.electronAPI?.migration?.detectSources?.();
        if (cancelled) return;
        setShowMigrationPhase(
          Boolean(result?.some((preview) => preview.found)),
        );
      } catch {
        // Best-effort; users can still import later from Settings.
      } finally {
        if (!cancelled) setMigrationDetectionResolved(true);
      }
    };
    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  const skippedPhases = useMemo(() => {
    const skipped = new Set<Phase>();
    if (!discoveryWelcomeExpected) skipped.add("enter");
    if (!showEnginePhase) skipped.add("engine");
    if (!migrationDetectionResolved || !showMigrationPhase)
      skipped.add("import");
    if (personalityImported) skipped.add("personality");
    return skipped.size > 0 ? skipped : undefined;
  }, [
    discoveryWelcomeExpected,
    migrationDetectionResolved,
    personalityImported,
    showEnginePhase,
    showMigrationPhase,
  ]);
  const discoverySelectionsRef = useRef(false);
  const initialNotificationSentRef = useRef(false);
  const handlePhaseChange = useCallback(
    (nextPhase: Phase) => {
      onSelectionChange?.(
        nextPhase === "browser" && discoverySelectionsRef.current,
      );
      onPhaseChange?.(nextPhase);
    },
    [onPhaseChange, onSelectionChange],
  );
  const {
    phase,
    leaving,
    rippleActive,
    maxVisitedSplitStepIndex,
    visibleSteps,
    nextSplitStep,
    prevSplitStep,
    continueIntro,
  } = useOnboardingFlow({
    initialPhase,
    onComplete,
    onEnterSplit,
    onInteract,
    onPhaseChange: handlePhaseChange,
    skippedPhases,
  });

  const discovery = useOnboardingDiscovery({
    isAuthenticated,
    nextSplitStep,
    onDiscoveryConfirm,
    onSelectionChange,
    phase,
  });
  discoverySelectionsRef.current = discovery.hasSelections;

  // Transitions notify their owner in the initiating transaction. The
  // initial phase has no initiating event, so mount is the one legitimate
  // lifecycle synchronization.
  useEffect(() => {
    if (initialNotificationSentRef.current) return;
    initialNotificationSentRef.current = true;
    handlePhaseChange(initialPhase);
  }, [handlePhaseChange, initialPhase]);

  const appearance = useOnboardingAppearance();
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
    let cancelled = false;
    let previousSuspended = false;
    const api = window.electronAPI?.system;

    void (async () => {
      try {
        const previous = await api?.getGlobalShortcutsSuspended?.();
        if (cancelled) return;
        previousSuspended = previous?.suspended === true;
        await api?.setGlobalShortcutsSuspended?.(true);
      } catch {
        // Onboarding demos should still run even if shortcut suspension is
        // unavailable in a dev shell.
      }
    })();

    return () => {
      cancelled = true;
      void api?.setGlobalShortcutsSuspended?.(previousSuspended);
    };
  }, []);

  /**
   * The progress strip groups its dots by act so the bottom of the
   * screen quietly mirrors the five-act story. Only steps the user
   * will actually see contribute dots.
   */
  const progressGroups = useMemo(() => {
    const groups: { act: OnboardingAct; steps: Phase[] }[] = [];
    for (const step of visibleSteps) {
      const act = PHASE_ACTS[step];
      if (!act) continue;
      const last = groups[groups.length - 1];
      if (last && last.act === act) {
        last.steps.push(step);
      } else {
        groups.push({ act, steps: [step] });
      }
    }
    return groups;
  }, [visibleSteps]);

  if (phase === "done") {
    return null;
  }

  const isSplit = SPLIT_PHASES.has(phase);
  const isComplete = phase === "complete";
  const splitStepIndex = SPLIT_STEP_ORDER.indexOf(phase);
  const canGoPrev = splitStepIndex > 0;
  const canGoNext = splitStepIndex < SPLIT_STEP_ORDER.length - 1;
  const canReturnNext =
    canGoNext && maxVisitedSplitStepIndex >= splitStepIndex + 1;
  const platform = getPlatform();
  const phaseAct = PHASE_ACTS[phase];

  const renderActiveSplitPhase = (activePhase: Phase) => {
    switch (activePhase) {
      case "capabilities":
        return (
          <OnboardingCapabilitiesPhase
            splitTransitionActive={leaving}
            onContinue={nextSplitStep}
          />
        );
      case "shapeshift":
        return (
          <OnboardingShapeshiftPhase
            splitTransitionActive={leaving}
            onContinue={nextSplitStep}
          />
        );
      case "engine":
        return (
          <OnboardingEnginePhase
            splitTransitionActive={leaving}
            onContinue={nextSplitStep}
          />
        );
      case "import":
        return (
          <OnboardingMigrationPhase
            splitTransitionActive={leaving}
            onContinue={nextSplitStep}
            onImported={(report) => {
              if (
                report.items.some(
                  (item) =>
                    item.kind === "personality" && item.status === "imported",
                )
              ) {
                setPersonalityImported(true);
              }
            }}
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
      case "theme":
        return (
          <OnboardingThemePhase
            colorMode={appearance.colorMode}
            gradientColor={appearance.gradientColor}
            gradientMode={appearance.gradientMode}
            sortedThemes={appearance.sortedThemes}
            splitTransitionActive={leaving}
            themeId={appearance.themeId}
            continueBlocked={!migrationDetectionResolved}
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
            personalityOptions={appearance.personalityOptions}
            personalityVoiceId={appearance.personalityVoiceId}
            defaultPersonalityVoiceId={appearance.defaultPersonalityVoiceId}
            splitTransitionActive={leaving}
            onFinish={nextSplitStep}
            onSelectVoice={appearance.selectPersonalityVoice}
          />
        );
      case "summon":
        return (
          <OnboardingSummonPhase
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
              {phaseAct ? (
                <div className="onboarding-act-label">
                  {t(ACT_LABEL_KEYS[phaseAct])}
                </div>
              ) : null}
              {STEP_TITLE_KEYS[phase] ? (
                <div className="onboarding-split-title">
                  {t(STEP_TITLE_KEYS[phase] as string)}
                </div>
              ) : null}
              {renderActiveSplitPhase(phase)}
            </div>
          </div>

          <div className="onboarding-progress" aria-hidden="true">
            {progressGroups.map((group) => (
              <div className="onboarding-progress__group" key={group.act}>
                {group.steps.map((step) => {
                  const stepIndex = SPLIT_STEP_ORDER.indexOf(step);
                  const state =
                    step === phase
                      ? "current"
                      : stepIndex < splitStepIndex
                        ? "done"
                        : "todo";
                  return (
                    <span
                      key={step}
                      className="onboarding-progress__dot"
                      data-state={state}
                    />
                  );
                })}
              </div>
            ))}
          </div>

          <div className="onboarding-phase-nav">
            <button
              type="button"
              className="onboarding-phase-nav-btn onboarding-phase-nav-btn--prev"
              disabled={!canGoPrev || leaving}
              onClick={prevSplitStep}
              aria-label={t("onboarding.previousStep")}
            >
              <ChevronLeft size={14} />
            </button>
            {canReturnNext ? (
              <button
                type="button"
                className="onboarding-phase-nav-btn onboarding-phase-nav-btn--next"
                disabled={leaving}
                onClick={nextSplitStep}
                aria-label={t("onboarding.nextStep")}
              >
                <ChevronRight size={14} />
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
};
