import { useCallback, useEffect, useState } from "react";

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

  const reset = useCallback(() => {
    setText("");
  }, []);

  const append = useCallback((delta: string) => {
    if (!delta) return;
    setText((prev) => prev + delta);
  }, []);

  useEffect(() => {
    if (active) {
      setText("");
    }
  }, [active]);

  return { text, append, reset };
}
