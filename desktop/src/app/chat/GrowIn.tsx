/**
 * GrowIn: OpenCode-style height animation wrapper.
 * Animates content height from 0 → auto using motion springs + ResizeObserver.
 * Includes edge-fade gradient during expansion and fade+blur entrance.
 */

import { useRef, useEffect, useState, type ReactNode } from "react";
import { animate } from "motion";
import "./grow-in.css";

interface GrowInProps {
  children: ReactNode;
  /** Whether to animate. When false, renders at full height immediately. */
  animate?: boolean;
  /** Spring duration in ms (default 500) */
  duration?: number;
  /** Show edge-fade gradient during expansion (default true) */
  edgeFade?: boolean;
  className?: string;
}

export function GrowIn({
  children,
  animate: shouldAnimate = true,
  duration = 500,
  edgeFade = true,
  className,
}: GrowInProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(!shouldAnimate);
  const controlsRef = useRef<ReturnType<typeof animate> | null>(null);

  useEffect(() => {
    const inner = innerRef.current;
    const outer = outerRef.current;
    if (!inner || !outer || !shouldAnimate) return;
    if (typeof ResizeObserver === "undefined") {
      // Fallback for environments without ResizeObserver (e.g. jsdom)
      setSettled(true);
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;

      // Stop previous animation, start new spring to measured height
      controlsRef.current?.stop();
      controlsRef.current = animate(
        outer,
        { height: `${h}px` },
        {
          type: "spring",
          duration: duration / 1000,
          bounce: 0,
          onComplete: () => setSettled(true),
        },
      );
    });

    observer.observe(inner);
    return () => {
      observer.disconnect();
      controlsRef.current?.stop();
    };
  }, [shouldAnimate, duration]);

  if (!shouldAnimate) {
    return <div className={className}>{children}</div>;
  }

  const showEdgeFade = edgeFade && !settled;

  return (
    <div
      ref={outerRef}
      className={`grow-in ${showEdgeFade ? "grow-in--edge-fade" : ""} ${settled ? "grow-in--settled" : ""} ${className ?? ""}`}
      style={{ height: "0px", overflow: settled ? undefined : "clip" }}
    >
      <div ref={innerRef} className="grow-in-inner">
        {children}
      </div>
    </div>
  );
}
