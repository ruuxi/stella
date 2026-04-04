import { useRef, useState, useCallback, useEffect } from "react";

/**
 * A state hook that batches rapid updates using requestAnimationFrame.
 * Useful for high-frequency updates like streaming text where we want to
 * reduce render cycles while maintaining smooth visual updates.
 */
export function useRafState<T>(initialValue: T): [T, (updater: T | ((prev: T) => T)) => void, React.RefObject<T>] {
  const [state, setState] = useState<T>(initialValue);
  const stateRef = useRef<T>(initialValue);
  const pendingRef = useRef<T | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const setRafState = useCallback((updater: T | ((prev: T) => T)) => {
    // Compute the new value
    const newValue = typeof updater === "function"
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
  React.RefObject<string>
] {
  const [text, setText, textRef] = useRafState("");

  const appendDelta = useCallback((delta: string) => {
    setText((prev) => prev + delta);
  }, [setText]);

  const reset = useCallback(() => {
    setText("");
  }, [setText]);

  return [text, appendDelta, reset, textRef];
}

const PACE_MS = 24;
const SNAP_RE = /[\s.,!?;:)\]]/;

function pacedStep(remaining: number) {
  if (remaining <= 12) return 2;
  if (remaining <= 48) return 4;
  if (remaining <= 96) return 8;
  return Math.min(24, Math.ceil(remaining / 8));
}

function pacedNext(text: string, start: number) {
  const end = Math.min(text.length, start + pacedStep(text.length - start));
  const max = Math.min(text.length, end + 8);
  for (let i = end; i < max; i++) {
    if (SNAP_RE.test(text[i] ?? "")) return i + 1;
  }
  return end;
}

/**
 * Paced text reveal modeled on OpenCode's createPacedValue.
 * Uses setTimeout (not RAF) to drip characters at ~24ms intervals with
 * adaptive step sizes that snap to word boundaries. Stops scheduling
 * when caught up — no idle spinning loop.
 *
 * When `active` turns false (stream ends), flushes remaining text instantly.
 */
export function useStreamBuffer(targetText: string, active: boolean): string {
  const [displayText, setDisplayText] = useState("");
  const shownRef = useRef("");
  const targetRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  targetRef.current = targetText;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const sync = useCallback((text: string) => {
    shownRef.current = text;
    setDisplayText(text);
  }, []);

  const tick = useCallback(() => {
    timerRef.current = null;
    const text = targetRef.current;
    const shown = shownRef.current;

    if (!text.startsWith(shown) || text.length <= shown.length) {
      sync(text);
      return;
    }

    const end = pacedNext(text, shown.length);
    sync(text.slice(0, end));

    if (end < text.length) {
      timerRef.current = setTimeout(tick, PACE_MS);
    }
  }, [sync]);

  useEffect(() => {
    if (!active) {
      clearTimer();
      sync(targetRef.current);
      return;
    }

    shownRef.current = "";
    setDisplayText("");
  }, [active, clearTimer, sync]);

  useEffect(() => {
    if (!active) {
      clearTimer();
      sync(targetText);
      return;
    }

    const shown = shownRef.current;
    if (!targetText.startsWith(shown) || targetText.length < shown.length) {
      clearTimer();
      sync(targetText);
      return;
    }

    if (targetText.length === shown.length || timerRef.current !== null) return;
    timerRef.current = setTimeout(tick, PACE_MS);
  }, [active, targetText, clearTimer, sync, tick]);

  useEffect(() => clearTimer, [clearTimer]);

  return displayText;
}
