import { useRef, useState, useCallback } from "react";

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
