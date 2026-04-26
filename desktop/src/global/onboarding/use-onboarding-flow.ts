import { useCallback, useEffect, useRef, useState } from "react";
import { SPLIT_STEP_ORDER, type Phase } from "./onboarding-flow";

const FADE_OUT_MS = 260;
const FADE_GAP_MS = 120;
const INTRO_CONTINUE_DELAY_MS = 1100;

type UseOnboardingFlowArgs = {
  initialPhase: Phase;
  onComplete: () => void;
  onEnterSplit?: () => void;
  onInteract?: () => void;
  onPhaseChange?: (phase: Phase) => void;
};

export function useOnboardingFlow({
  initialPhase,
  onComplete,
  onEnterSplit,
  onInteract,
  onPhaseChange,
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
