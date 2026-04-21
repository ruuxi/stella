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
const CURSOR_STEP_MS = 900;

export function ScreenGuideAnnotations({
  annotations,
  visible,
  onDismiss,
}: ScreenGuideAnnotationsProps) {
  const [showDom, setShowDom] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  const clearTimers = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (cursorTimerRef.current) {
      clearInterval(cursorTimerRef.current);
      cursorTimerRef.current = null;
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- syncs transient animation state (showDom/exiting/cursorIndex) with the visible prop; setState calls are reset operations for a new animation cycle, not derived state */
  useEffect(() => {
    if (visible && annotations.length > 0) {
      clearTimers();
      setExiting(false);
      setShowDom(true);
      setCursorIndex(0);
      if (annotations.length > 1) {
        cursorTimerRef.current = setInterval(() => {
          setCursorIndex((current) => {
            if (current >= annotations.length - 1) {
              if (cursorTimerRef.current) {
                clearInterval(cursorTimerRef.current);
                cursorTimerRef.current = null;
              }
              return current;
            }
            return current + 1;
          });
        }, CURSOR_STEP_MS);
      }
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
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => clearTimers, [clearTimers]);

  if (!showDom) return null;

  const activeAnnotation =
    annotations[Math.min(cursorIndex, annotations.length - 1)];

  return (
    <div
      className={`screen-guide-root ${exiting ? "screen-guide-exiting" : "screen-guide-entering"}`}
    >
      {activeAnnotation ? (
        <div
          className="screen-guide-cursor"
          style={{
            left: activeAnnotation.x,
            top: activeAnnotation.y,
          }}
          aria-hidden="true"
        >
          <div className="screen-guide-cursor-pulse" />
          <div className="screen-guide-cursor-pointer" />
        </div>
      ) : null}
      {annotations.map((ann, index) => (
        <div
          key={ann.id}
          className={`screen-guide-pill ${index === cursorIndex ? "screen-guide-pill-active" : ""}`}
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
