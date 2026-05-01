import { useCallback, useEffect, useRef, useState } from "react";
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
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [leaving, setLeaving] = useState(false);
  const [rippleActive, setRippleActive] = useState(initialPhase === "intro");
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTransitionTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    onPhaseChange?.(phase);
  }, [onPhaseChange, phase]);

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
      clearTransitionTimeout();

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
    [clearTransitionTimeout, prefersReducedMotion],
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
    if (phase === "complete") {
      clearTransitionTimeout();
      setPhase("done");
      onComplete();
    }

    return clearTransitionTimeout;
  }, [clearTransitionTimeout, onComplete, phase]);

  useEffect(() => clearTransitionTimeout, [clearTransitionTimeout]);

  const nextSplitStep = useCallback(() => {
    const index = SPLIT_STEP_ORDER.indexOf(phase);
    const nextIndex = advancePastSkipped(index + 1, 1, skippedPhases);
    if (nextIndex < SPLIT_STEP_ORDER.length) {
      onInteract?.();
      transitionTo(SPLIT_STEP_ORDER[nextIndex]);
      return;
    }

    onInteract?.();
    transitionTo("complete");
  }, [onInteract, phase, skippedPhases, transitionTo]);

  const prevSplitStep = useCallback(() => {
    const index = SPLIT_STEP_ORDER.indexOf(phase);
    const prevIndex = advancePastSkipped(index - 1, -1, skippedPhases);
    if (prevIndex >= 0) {
      onInteract?.();
      transitionTo(SPLIT_STEP_ORDER[prevIndex]);
    }
  }, [onInteract, phase, skippedPhases, transitionTo]);

  const continueIntro = useCallback(() => {
    onInteract?.();
    onEnterSplit?.();
    transitionTo("capabilities");
  }, [onEnterSplit, onInteract, transitionTo]);

  return {
    phase,
    leaving,
    rippleActive,
    nextSplitStep,
    prevSplitStep,
    continueIntro,
  };
}
