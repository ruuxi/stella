/**
 * GrowIn: OpenCode-style height animation wrapper.
 * Animates content height from 0 → auto on mount using ResizeObserver.
 * Includes edge-fade gradient during expansion and fade+blur entrance.
 */

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
  type CSSProperties,
} from "react";
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

// Spring-like cubic bezier matching OpenCode's GROW_SPRING (visualDuration: 0.5, bounce: 0)
const SPRING_EASING = "cubic-bezier(0.34, 1.02, 0.64, 1)";

export function GrowIn({
  children,
  animate = true,
  duration = 500,
  edgeFade = true,
  className,
}: GrowInProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const [settled, setSettled] = useState(!animate);
  const edgeFadeTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Track content height via ResizeObserver
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || !animate) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      setMeasuredHeight(h);
    });

    observer.observe(inner);
    return () => observer.disconnect();
  }, [animate]);

  // Mark settled after transition completes (remove overflow clip, edge fade)
  const handleTransitionEnd = useCallback(() => {
    setSettled(true);
  }, []);

  // Edge fade cleanup timer — fallback if transitionend doesn't fire
  useEffect(() => {
    if (!animate || settled) return;
    edgeFadeTimerRef.current = setTimeout(() => {
      setSettled(true);
    }, duration + 300);
    return () => clearTimeout(edgeFadeTimerRef.current);
  }, [animate, duration, settled]);

  if (!animate) {
    return <div className={className}>{children}</div>;
  }

  const showEdgeFade = edgeFade && !settled && measuredHeight !== null;

  const style: CSSProperties = {
    height: measuredHeight !== null ? `${measuredHeight}px` : "0px",
    transitionProperty: "height",
    transitionDuration: `${duration}ms`,
    transitionTimingFunction: SPRING_EASING,
    overflow: settled ? undefined : "clip",
  };

  return (
    <div
      ref={outerRef}
      className={`grow-in ${showEdgeFade ? "grow-in--edge-fade" : ""} ${settled ? "grow-in--settled" : ""} ${className ?? ""}`}
      style={style}
      onTransitionEnd={handleTransitionEnd}
    >
      <div ref={innerRef} className="grow-in-inner">
        {children}
      </div>
    </div>
  );
}
