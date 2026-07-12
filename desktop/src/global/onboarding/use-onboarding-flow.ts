import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SPLIT_STEP_ORDER, type Phase } from "./onboarding-flow";

// Permissions are macOS TCC concepts (Accessibility, Screen Capture);
// on other platforms the cards are no-ops, so skip the phase entirely.
const PLATFORM_SKIPPED_PHASES: ReadonlySet<Phase> =
  typeof window !== "undefined" && window.electronAPI?.platform !== "darwin"
    ? new Set<Phase>(["permissions"])
    : new Set<Phase>();

const advancePastSkipped = (
  index: number,
  direction: 1 | -1,
  skippedPhases: ReadonlySet<Phase> = PLATFORM_SKIPPED_PHASES,
): number => {
  let cursor = index;
  while (
    cursor >= 0 &&
    cursor < SPLIT_STEP_ORDER.length &&
    skippedPhases.has(SPLIT_STEP_ORDER[cursor])
  ) {
    cursor += direction;
  }
  return cursor;
};

const FADE_OUT_MS = 260;
const FADE_GAP_MS = 120;
const INTRO_CONTINUE_DELAY_MS = 1100;

type UseOnboardingFlowArgs = {
  initialPhase: Phase;
  onComplete: () => void;
  onEnterSplit?: () => void;
  onInteract?: () => void;
  onPhaseChange?: (phase: Phase) => void;
  skippedPhases?: ReadonlySet<Phase>;
};

export function useOnboardingFlow({
  initialPhase,
  onComplete,
  onEnterSplit,
  onInteract,
  onPhaseChange,
  skippedPhases,
}: UseOnboardingFlowArgs) {
  const effectiveSkippedPhases = useMemo(() => {
    if (!skippedPhases || skippedPhases.size === 0)
      return PLATFORM_SKIPPED_PHASES;
    if (PLATFORM_SKIPPED_PHASES.size === 0) return skippedPhases;
    return new Set<Phase>([...PLATFORM_SKIPPED_PHASES, ...skippedPhases]);
  }, [skippedPhases]);

  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [leaving, setLeaving] = useState(false);
  const [rippleActive, setRippleActive] = useState(initialPhase === "intro");
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [maxVisitedSplitStepIndex, setMaxVisitedSplitStepIndex] = useState(() =>
    Math.max(SPLIT_STEP_ORDER.indexOf(initialPhase), 0),
  );
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTransitionTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return clearTransitionTimeout;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => {
      setPrefersReducedMotion(mediaQuery.matches);
    };

    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => {
      mediaQuery.removeEventListener("change", updatePreference);
      clearTransitionTimeout();
    };
  }, [clearTransitionTimeout]);

  const transitionTo = useCallback(
    (next: Phase) => {
      clearTransitionTimeout();

      const commitTransition = () => {
        if (next === "complete") {
          setLeaving(false);
          setPhase("done");
          onPhaseChange?.("done");
          onComplete();
          return;
        }

        const splitIndex = SPLIT_STEP_ORDER.indexOf(next);
        if (splitIndex >= 0) {
          setMaxVisitedSplitStepIndex((current) =>
            Math.max(current, splitIndex),
          );
        }
        setLeaving(false);
        setPhase(next);
        onPhaseChange?.(next);
      };

      if (prefersReducedMotion) {
        commitTransition();
        return;
      }

      setLeaving(true);
      timeoutRef.current = setTimeout(() => {
        commitTransition();
        timeoutRef.current = null;
      }, FADE_OUT_MS + FADE_GAP_MS);
    },
    [
      clearTransitionTimeout,
      onComplete,
      onPhaseChange,
      prefersReducedMotion,
    ],
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

  const nextSplitStep = useCallback(() => {
    const index = SPLIT_STEP_ORDER.indexOf(phase);
    const nextIndex = advancePastSkipped(index + 1, 1, effectiveSkippedPhases);
    if (nextIndex < SPLIT_STEP_ORDER.length) {
      onInteract?.();
      transitionTo(SPLIT_STEP_ORDER[nextIndex]);
      return;
    }

    onInteract?.();
    transitionTo("complete");
  }, [effectiveSkippedPhases, onInteract, phase, transitionTo]);

  const prevSplitStep = useCallback(() => {
    const index = SPLIT_STEP_ORDER.indexOf(phase);
    const prevIndex = advancePastSkipped(index - 1, -1, effectiveSkippedPhases);
    if (prevIndex >= 0) {
      onInteract?.();
      transitionTo(SPLIT_STEP_ORDER[prevIndex]);
    }
  }, [effectiveSkippedPhases, onInteract, phase, transitionTo]);

  const continueIntro = useCallback(() => {
    onInteract?.();
    onEnterSplit?.();
    transitionTo("capabilities");
  }, [onEnterSplit, onInteract, transitionTo]);

  // The steps the user will actually walk through — platform and
  // conditional skips removed. Drives the progress strip so a macOS
  // user and a Windows user each see an honest step count.
  const visibleSteps = useMemo(
    () => SPLIT_STEP_ORDER.filter((step) => !effectiveSkippedPhases.has(step)),
    [effectiveSkippedPhases],
  );

  return {
    phase,
    leaving,
    rippleActive,
    maxVisitedSplitStepIndex,
    visibleSteps,
    nextSplitStep,
    prevSplitStep,
    continueIntro,
  };
}
