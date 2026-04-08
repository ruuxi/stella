import { useCallback, useEffect, useRef, useState } from "react";
import "./screen-guide.css";

export type ScreenGuideAnnotation = {
  id: string;
  label: string;
  x: number;
  y: number;
};

type ScreenGuideAnnotationsProps = {
  annotations: ScreenGuideAnnotation[];
  visible: boolean;
  onDismiss?: () => void;
};

const AUTO_DISMISS_MS = 10_000;
const EXIT_DURATION_MS = 350;

export function ScreenGuideAnnotations({
  annotations,
  visible,
  onDismiss,
}: ScreenGuideAnnotationsProps) {
  const [showDom, setShowDom] = useState(false);
  const [exiting, setExiting] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const clearTimers = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (visible && annotations.length > 0) {
      clearTimers();
      setExiting(false);
      setShowDom(true);
      dismissTimerRef.current = setTimeout(() => {
        onDismissRef.current?.();
      }, AUTO_DISMISS_MS);
      return;
    }

    if (!visible && showDom) {
      clearTimers();
      setExiting(true);
      exitTimerRef.current = setTimeout(() => {
        setShowDom(false);
        setExiting(false);
      }, EXIT_DURATION_MS);
    }
  }, [visible, annotations.length, showDom, clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  if (!showDom) return null;

  return (
    <div
      className={`screen-guide-root ${exiting ? "screen-guide-exiting" : "screen-guide-entering"}`}
    >
      {annotations.map((ann) => (
        <div
          key={ann.id}
          className="screen-guide-pill"
          style={{
            left: ann.x + 24,
            top: ann.y,
          }}
        >
          {ann.label}
        </div>
      ))}
    </div>
  );
}
