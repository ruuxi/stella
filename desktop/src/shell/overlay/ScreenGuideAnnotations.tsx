import { useEffect, useRef, useState } from "react";
import "./screen-guide.css";

export type ScreenGuideAnnotation = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type ScreenGuideAnnotationsProps = {
  annotations: ScreenGuideAnnotation[];
  visible: boolean;
  onDismiss?: () => void;
};

const AUTO_DISMISS_MS = 10_000;

export function ScreenGuideAnnotations({
  annotations,
  visible,
  onDismiss,
}: ScreenGuideAnnotationsProps) {
  const [phase, setPhase] = useState<"hidden" | "entering" | "visible" | "exiting">("hidden");
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible && annotations.length > 0) {
      setPhase("entering");
      const raf = requestAnimationFrame(() => {
        setTimeout(() => setPhase("visible"), 300);
      });
      dismissTimerRef.current = setTimeout(() => {
        onDismiss?.();
      }, AUTO_DISMISS_MS);
      return () => {
        cancelAnimationFrame(raf);
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      };
    }

    if (!visible && phase !== "hidden") {
      setPhase("exiting");
      const timer = setTimeout(() => setPhase("hidden"), 350);
      return () => clearTimeout(timer);
    }
  }, [visible, annotations.length, onDismiss, phase]);

  if (phase === "hidden") return null;

  const rootClassName = [
    "screen-guide-root",
    phase === "entering" && "screen-guide-entering",
    phase === "exiting" && "screen-guide-exiting",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClassName}>
      {annotations.map((ann) => (
        <div
          key={ann.id}
          className="screen-guide-pill"
          style={{
            left: ann.x + ann.width / 2,
            top: ann.y + ann.height / 2,
          }}
        >
          {ann.label}
        </div>
      ))}
    </div>
  );
}
