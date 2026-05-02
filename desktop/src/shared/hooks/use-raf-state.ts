import { useRef, useState, useCallback, useEffect } from "react";

/**
 * A state hook that batches rapid updates using requestAnimationFrame.
 * Useful for high-frequency updates like streaming text where we want to
 * reduce render cycles while maintaining smooth visual updates.
 */
function useRafState<T>(
  initialValue: T,
): [T, (updater: T | ((prev: T) => T)) => void, React.RefObject<T>] {
  const [state, setState] = useState<T>(initialValue);
  const stateRef = useRef<T>(initialValue);
  const pendingRef = useRef<T | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const setRafState = useCallback((updater: T | ((prev: T) => T)) => {
    // Compute the new value
    const newValue =
      typeof updater === "function"
        ? (updater as (prev: T) => T)(stateRef.current)
        : updater;

    // Update refs immediately for synchronous access
    stateRef.current = newValue;
    pendingRef.current = newValue;

    // Schedule state update if not already scheduled
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (pendingRef.current !== null) {
          setState(pendingRef.current);
          pendingRef.current = null;
        }
      });
    }
  }, []);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      pendingRef.current = null;
    };
  }, []);

  return [state, setRafState, stateRef];
}

/**
 * Creates a RAF-batched string accumulator.
 * Returns [currentText, appendDelta, reset, textRef]
 */
export function useRafStringAccumulator(): [
  string,
  (delta: string) => void,
  () => void,
  React.RefObject<string>,
] {
  const [text, setText, textRef] = useRafState("");

  const appendDelta = useCallback(
    (delta: string) => {
      setText((prev) => prev + delta);
    },
    [setText],
  );

  const reset = useCallback(() => {
    setText("");
  }, [setText]);

  return [text, appendDelta, reset, textRef];
}

const BASE_PACE_MS = 24;
const INITIAL_HOLD_MS = 140;
const LOW_BACKLOG_HOLD_MS = 180;
const MAX_LOW_BACKLOG_HOLD_MS = 420;
const SOFT_LEAD_CHARS = 18;
const SNAP_RE = /[\s.,!?;:)\]]/;

function pacedDelay(remaining: number, targetAgeMs: number) {
  if (remaining > 180) return 10;
  if (remaining > 96) return 14;
  if (remaining > 48) return 18;
  if (targetAgeMs > MAX_LOW_BACKLOG_HOLD_MS) return 28;
  return BASE_PACE_MS;
}

function pacedStep(remaining: number, targetAgeMs: number) {
  if (remaining > 180) return Math.min(32, Math.ceil(remaining / 6));
  if (remaining > 96) return 18;
  if (remaining > 48) return 10;
  if (targetAgeMs > MAX_LOW_BACKLOG_HOLD_MS) return 4;
  if (remaining <= 12) return 2;
  return 4;
}

function pacedNext(text: string, start: number, targetAgeMs: number) {
  const end = Math.min(
    text.length,
    start + pacedStep(text.length - start, targetAgeMs),
  );
  const max = Math.min(text.length, end + 8);
  for (let i = end; i < max; i++) {
    if (SNAP_RE.test(text[i] ?? "")) return i + 1;
  }
  return end;
}

function remainingHoldMs(
  remaining: number,
  targetAgeMs: number,
  hasStarted: boolean,
) {
  if (!hasStarted) {
    return Math.max(0, INITIAL_HOLD_MS - targetAgeMs);
  }
  if (remaining <= SOFT_LEAD_CHARS && targetAgeMs < LOW_BACKLOG_HOLD_MS) {
    return LOW_BACKLOG_HOLD_MS - targetAgeMs;
  }
  return 0;
}

/**
 * Paced text reveal with a tiny jitter buffer in front of the UI.
 * Providers often deliver uneven bursts, so the visible text intentionally
 * keeps a small lead, drains faster when the backlog grows, and only catches
 * all the way up when upstream has actually paused.
 *
 * When `active` turns false (stream ends), flushes remaining text instantly.
 */
export function useStreamBuffer(targetText: string, active: boolean): string {
  const [displayText, setDisplayText] = useState("");
  const shownRef = useRef("");
  const targetRef = useRef("");
  const targetChangedAtRef = useRef(0);
  const hasStartedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displaySyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const tickRef = useRef<() => void>(() => {});

  const clearDisplaySyncTimer = useCallback(() => {
    if (displaySyncTimerRef.current !== null) {
      clearTimeout(displaySyncTimerRef.current);
      displaySyncTimerRef.current = null;
    }
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const sync = useCallback(
    (text: string) => {
      clearDisplaySyncTimer();
      shownRef.current = text;
      setDisplayText(text);
    },
    [clearDisplaySyncTimer],
  );

  const deferSync = useCallback(
    (text: string) => {
      clearDisplaySyncTimer();
      shownRef.current = text;
      displaySyncTimerRef.current = setTimeout(() => {
        displaySyncTimerRef.current = null;
        setDisplayText(shownRef.current);
      }, 0);
    },
    [clearDisplaySyncTimer],
  );

  const scheduleTick = useCallback((delayMs: number) => {
    timerRef.current = setTimeout(() => {
      tickRef.current();
    }, delayMs);
  }, []);

  const tick = useCallback(() => {
    timerRef.current = null;
    const text = targetRef.current;
    const shown = shownRef.current;
    const remaining = text.length - shown.length;

    if (!text.startsWith(shown) || remaining <= 0) {
      sync(text);
      return;
    }

    const targetAgeMs = Date.now() - targetChangedAtRef.current;
    const holdMs = remainingHoldMs(
      remaining,
      targetAgeMs,
      hasStartedRef.current,
    );
    if (holdMs > 0) {
      scheduleTick(holdMs);
      return;
    }

    const end = pacedNext(text, shown.length, targetAgeMs);
    hasStartedRef.current = true;
    sync(text.slice(0, end));

    if (end < text.length) {
      scheduleTick(pacedDelay(text.length - end, targetAgeMs));
    }
  }, [scheduleTick, sync]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    if (!active) {
      clearTimer();
      deferSync(targetRef.current);
      return;
    }

    targetRef.current = "";
    targetChangedAtRef.current = Date.now();
    hasStartedRef.current = false;
    shownRef.current = "";
    deferSync("");
  }, [active, clearTimer, deferSync]);

  useEffect(() => {
    if (!active) {
      clearTimer();
      deferSync(targetText);
      return;
    }

    if (targetText !== targetRef.current) {
      targetRef.current = targetText;
      targetChangedAtRef.current = Date.now();
    }

    const shown = shownRef.current;
    if (!targetText.startsWith(shown) || targetText.length < shown.length) {
      clearTimer();
      hasStartedRef.current = targetText.length > 0;
      deferSync(targetText);
      return;
    }

    if (targetText.length === shown.length || timerRef.current !== null) return;
    scheduleTick(0);
  }, [active, targetText, clearTimer, deferSync, scheduleTick]);

  useEffect(
    () => () => {
      clearTimer();
      clearDisplaySyncTimer();
    },
    [clearDisplaySyncTimer, clearTimer],
  );

  return displayText;
}
