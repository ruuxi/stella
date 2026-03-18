/**
 * GrowIn: height animation wrapper.
 * Animates content height from 0 → auto using motion springs + ResizeObserver.
 * Includes fade+blur entrance on inner content.
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
  className?: string;
}

export function GrowIn({
  children,
  animate: shouldAnimate = true,
  duration = 500,
  className,
}: GrowInProps) {
  const canAnimate = shouldAnimate && typeof ResizeObserver !== "undefined";
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(!canAnimate);
  const controlsRef = useRef<ReturnType<typeof animate> | null>(null);

  useEffect(() => {
    const inner = innerRef.current;
    const outer = outerRef.current;
    if (!inner || !outer || !canAnimate) return;

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
  }, [canAnimate, duration]);

  if (!canAnimate) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div
      ref={outerRef}
      className={`grow-in${className ? ` ${className}` : ""}`}
      style={{ height: "0px", overflow: settled ? undefined : "clip" }}
    >
      <div ref={innerRef} className="grow-in-inner">
        {children}
      </div>
    </div>
  );
}
