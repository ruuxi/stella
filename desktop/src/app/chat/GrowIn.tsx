/**
 * GrowIn: height animation wrapper.
 * Animates content height from 0 → auto using motion springs + ResizeObserver.
 * Includes fade+blur entrance on inner content.
 *
 * When `show` transitions to false, animates height → 0 with fade+blur out,
 * then unmounts children. Caches last visible children during exit so the
 * content doesn't disappear before the shrink animation finishes.
 */

import { useRef, useEffect, useState, type ReactNode } from "react";
import { animate } from "motion";
import "./grow-in.css";

interface GrowInProps {
  children: ReactNode;
  /** Whether to animate. When false, renders at full height immediately. */
  animate?: boolean;
  /** Controls visibility with animated enter/exit. Default true. */
  show?: boolean;
  /** Spring duration in ms (default 500) */
  duration?: number;
  className?: string;
}

export function GrowIn({
  children,
  animate: shouldAnimate = true,
  show = true,
  duration = 500,
  className,
}: GrowInProps) {
  const canAnimate = shouldAnimate && typeof ResizeObserver !== "undefined";
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(!canAnimate);
  const [exited, setExited] = useState(!show);
  const controlsRef = useRef<ReturnType<typeof animate> | null>(null);
  const cachedChildrenRef = useRef<ReactNode>(children);
  const showRef = useRef(show);
  const entranceDoneRef = useRef(!canAnimate);

  // Cache children while visible so exit animation has content to shrink
  if (show) {
    cachedChildrenRef.current = children;
  }

  // Handle show/hide transitions
  useEffect(() => {
    const prevShow = showRef.current;
    showRef.current = show;

    if (!canAnimate) {
      setExited(!show);
      return;
    }

    const outer = outerRef.current;
    if (!outer) return;

    if (prevShow && !show) {
      // Exit: shrink to 0
      controlsRef.current?.stop();
      setSettled(false);
      entranceDoneRef.current = false;
      controlsRef.current = animate(
        outer,
        { height: "0px", opacity: 0 },
        {
          type: "spring",
          duration: duration / 1000,
          bounce: 0,
          onComplete: () => setExited(true),
        },
      );
    } else if (!prevShow && show) {
      // Re-enter: reset for grow-in
      setExited(false);
      setSettled(false);
      entranceDoneRef.current = false;
      outer.style.height = "0px";
      outer.style.opacity = "1";
    }
  }, [show, canAnimate, duration]);

  // After the entrance animation period, remove overflow:clip and switch to
  // snapping height. During streaming the ResizeObserver restarts the spring on
  // every chunk, so onComplete never fires and overflow:clip persists — clipping
  // the bottom of the last assistant message. This timer guarantees the clip is
  // lifted after the entrance window regardless.
  useEffect(() => {
    if (!canAnimate || !show) {
      entranceDoneRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      entranceDoneRef.current = true;
      const inner = innerRef.current;
      const outer = outerRef.current;
      if (inner && outer) {
        controlsRef.current?.stop();
        outer.style.height = `${inner.getBoundingClientRect().height}px`;
      }
      setSettled(true);
    }, duration);
    return () => clearTimeout(timer);
  }, [canAnimate, show, duration]);

  // ResizeObserver for entrance/resize tracking (only when showing)
  useEffect(() => {
    const inner = innerRef.current;
    const outer = outerRef.current;
    if (!inner || !outer || !canAnimate || !show) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;

      // After the entrance period, snap height immediately so content is
      // never clipped by a lagging spring animation.
      if (entranceDoneRef.current) {
        controlsRef.current?.stop();
        outer.style.height = `${h}px`;
        return;
      }

      controlsRef.current?.stop();
      controlsRef.current = animate(
        outer,
        { height: `${h}px` },
        {
          type: "spring",
          duration: duration / 1000,
          bounce: 0,
          onComplete: () => {
            entranceDoneRef.current = true;
            setSettled(true);
          },
        },
      );
    });

    observer.observe(inner);
    return () => {
      observer.disconnect();
      controlsRef.current?.stop();
    };
  }, [canAnimate, duration, show]);

  if (!canAnimate) {
    if (!show) return null;
    return <div className={className}>{children}</div>;
  }

  // Fully exited — render nothing
  if (exited && !show) return null;

  const displayChildren = show ? children : cachedChildrenRef.current;

  return (
    <div
      ref={outerRef}
      className={`grow-in${className ? ` ${className}` : ""}`}
      style={{ height: "0px", overflow: settled ? undefined : "clip" }}
    >
      <div
        ref={innerRef}
        className={`grow-in-inner${!show ? " grow-in-exiting" : ""}`}
      >
        {displayChildren}
      </div>
    </div>
  );
}
