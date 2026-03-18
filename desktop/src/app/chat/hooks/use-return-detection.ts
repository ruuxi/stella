/**
 * Detects when the user returns to the app after being away for a threshold
 * period. Fires a callback so the caller can send a synthetic message to
 * the orchestrator.
 */

import { useEffect, useRef } from "react";

const AWAY_THRESHOLD_MS = 45 * 60 * 1000; // 45 minutes

type UseReturnDetectionOptions = {
  /** Called when the user returns after being away longer than the threshold. */
  onReturn: (awayDurationMs: number) => void;
  /** Whether detection is active (e.g., only when a conversation exists). */
  enabled?: boolean;
};

const formatDuration = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours} hour${hours !== 1 ? "s" : ""}`;
  return `${hours} hour${hours !== 1 ? "s" : ""} ${remainingMinutes} minute${remainingMinutes !== 1 ? "s" : ""}`;
};

export { formatDuration };

export const useReturnDetection = ({
  onReturn,
  enabled = true,
}: UseReturnDetectionOptions) => {
  const lastActiveRef = useRef(0);
  const onReturnRef = useRef(onReturn);

  useEffect(() => {
    onReturnRef.current = onReturn;
  }, [onReturn]);

  useEffect(() => {
    if (!enabled) return;
    lastActiveRef.current = Date.now();

    // Update last active time on any user interaction
    const updateActivity = () => {
      lastActiveRef.current = Date.now();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) return;

      const now = Date.now();
      const awayMs = now - lastActiveRef.current;
      if (awayMs >= AWAY_THRESHOLD_MS) {
        onReturnRef.current(awayMs);
      }
      lastActiveRef.current = now;
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    // Track activity so we measure from last real interaction, not last visibility change
    document.addEventListener("keydown", updateActivity, { passive: true });
    document.addEventListener("mousedown", updateActivity, { passive: true });

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("keydown", updateActivity);
      document.removeEventListener("mousedown", updateActivity);
    };
  }, [enabled]);
};
