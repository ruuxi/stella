import { useCallback, useEffect, useRef, useState } from "react";

export type StreamBuffer = {
  text: string;
  append: (delta: string) => void;
  reset: () => void;
};

/**
 * Holds streamed assistant/reasoning text for the active run. Appends apply
 * immediately; clears when the run becomes active again or when `reset()`
 * runs.
 */
export function useStreamBuffer(active: boolean): StreamBuffer {
  const [text, setText] = useState("");
  const activeRef = useRef(active);
  activeRef.current = active;

  const reset = useCallback(() => {
    setText("");
  }, []);

  const append = useCallback((delta: string) => {
    if (!delta || !activeRef.current) return;
    setText((prev) => prev + delta);
  }, []);

  useEffect(() => {
    if (active) {
      setText("");
    }
  }, [active]);

  return { text, append, reset };
}
