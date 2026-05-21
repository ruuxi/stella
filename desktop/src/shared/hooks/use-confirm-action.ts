import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Two-click "armed → confirmed" pattern used by destructive affordances
 * in the display sidebar (canvas tile remove, media item delete).
 * First call arms the action and starts a timeout that disarms it; the
 * second call within the window invokes `action`.
 */
export const useConfirmAction = (
  action: () => void,
  { armedMs = 3000 }: { armedMs?: number } = {},
): { armed: boolean; trigger: () => void; reset: () => void } => {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clear();
    setArmed(false);
  }, [clear]);

  useEffect(() => clear, [clear]);

  const trigger = useCallback(() => {
    if (!armed) {
      clear();
      setArmed(true);
      timerRef.current = setTimeout(() => setArmed(false), armedMs);
      return;
    }
    reset();
    action();
  }, [action, armed, armedMs, clear, reset]);

  return { armed, trigger, reset };
};
