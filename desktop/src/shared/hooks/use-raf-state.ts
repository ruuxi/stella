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

/**
 * Smooths bursty streaming text into a steady character drip.
 * Runs a persistent RAF loop while `active` is true, releasing a fraction
 * of the buffered characters each frame so text appears at a constant rate
 * regardless of how unevenly tokens arrive from the network.
 *
 * When `active` turns false (stream ends), flushes remaining buffer instantly.
 */
export function useStreamBuffer(targetText: string, active: boolean): string {
  const [displayText, setDisplayText] = useState("");
  const displayLenRef = useRef(0);
  const targetRef = useRef("");
  const activeRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  targetRef.current = targetText;
  activeRef.current = active;

  useEffect(() => {
    if (!active) {
      // Flush: show full text immediately when stream ends
      const target = targetRef.current;
      displayLenRef.current = target.length;
      setDisplayText(target);
      return;
    }

    // Reset cursor when a new stream starts
    displayLenRef.current = 0;
    setDisplayText("");

    const tick = () => {
      const target = targetRef.current;
      const currentLen = displayLenRef.current;

      if (currentLen < target.length) {
        const remaining = target.length - currentLen;
        // Adaptive: release 12% of remaining buffer per frame, minimum 3 chars.
        // At 60fps this drains a 50-char burst in ~10 frames (~170ms).
        const step = Math.max(3, Math.ceil(remaining * 0.12));
        const nextLen = Math.min(currentLen + step, target.length);
        displayLenRef.current = nextLen;
        setDisplayText(target.slice(0, nextLen));
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [active]);

  return displayText;
}
