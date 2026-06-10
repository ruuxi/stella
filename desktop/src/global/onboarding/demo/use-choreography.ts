import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ChoreographyCue = {
  id: string;
  /** Milliseconds after the script starts. */
  at: number;
};

type UseChoreographyArgs = {
  cues: readonly ChoreographyCue[];
  /** The script only runs while active; flipping to false resets it. */
  active: boolean;
  onDone?: () => void;
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Timeline driver for the onboarding demos. A demo declares named cues
 * ("user-message", "work-1", "reply", …) with millisecond offsets; the
 * hook reveals each cue as its time passes and reports completion. The
 * cue set — not CSS animation-delays — is the single source of truth
 * for what's on screen, so a demo can be restarted, fast-forwarded for
 * reduced motion, or paused when the window is hidden without any
 * keyframe bookkeeping drifting out of sync.
 */
export function useChoreography({ cues, active, onDone }: UseChoreographyArgs) {
  const [passed, setPassed] = useState<ReadonlySet<string>>(() => new Set());
  const [done, setDone] = useState(false);
  const [runKey, setRunKey] = useState(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const sortedCues = useMemo(
    () => [...cues].sort((a, b) => a.at - b.at),
    [cues],
  );

  useEffect(() => {
    if (!active) {
      setPassed(new Set());
      setDone(false);
      return;
    }

    if (prefersReducedMotion()) {
      setPassed(new Set(sortedCues.map((cue) => cue.id)));
      setDone(true);
      onDoneRef.current?.();
      return;
    }

    setPassed(new Set());
    setDone(false);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cursor = 0;
    // Pause bookkeeping: `elapsed` accumulates run time across hidden
    // periods so resuming continues where the scene left off.
    let elapsed = 0;
    let segmentStartedAt = Date.now();
    let paused = false;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNext = () => {
      clearTimer();
      if (cancelled || cursor >= sortedCues.length) return;
      const wait = Math.max(0, sortedCues[cursor].at - elapsed);
      timer = setTimeout(() => {
        if (cancelled) return;
        elapsed = Math.max(elapsed, sortedCues[cursor].at);
        segmentStartedAt = Date.now();
        const reached = sortedCues[cursor].id;
        cursor += 1;
        setPassed((prev) => {
          const next = new Set(prev);
          next.add(reached);
          return next;
        });
        if (cursor >= sortedCues.length) {
          setDone(true);
          onDoneRef.current?.();
          return;
        }
        scheduleNext();
      }, wait);
    };

    const pause = () => {
      if (paused) return;
      paused = true;
      elapsed += Date.now() - segmentStartedAt;
      clearTimer();
    };

    const resume = () => {
      if (!paused) return;
      paused = false;
      segmentStartedAt = Date.now();
      scheduleNext();
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") pause();
      else resume();
    };

    if (document.visibilityState === "hidden") {
      paused = true;
    } else {
      scheduleNext();
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, runKey, sortedCues]);

  const restart = useCallback(() => {
    setRunKey((key) => key + 1);
  }, []);

  const has = useCallback((id: string) => passed.has(id), [passed]);

  return { passed, has, done, restart, runKey };
}

/**
 * Character-by-character typing for the demo composer. Returns the
 * visible prefix of `text`; empty until `active`, full text instantly
 * under reduced motion.
 */
export function useTypedText(
  text: string,
  active: boolean,
  {
    startDelay = 0,
    charMs = 26,
  }: { startDelay?: number; charMs?: number } = {},
) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!active) {
      setCount(0);
      return;
    }
    if (prefersReducedMotion()) {
      setCount(text.length);
      return;
    }

    setCount(0);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = (next: number) => {
      if (cancelled) return;
      setCount(next);
      if (next < text.length) {
        timer = setTimeout(() => tick(next + 1), charMs);
      }
    };

    timer = setTimeout(() => tick(1), startDelay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, charMs, startDelay, text]);

  return {
    value: text.slice(0, count),
    typing: active && count > 0 && count < text.length,
    typed: count >= text.length,
  };
}
