/**
 * TextShimmer: animated gradient shimmer across the entire string.
 */

import { useEffect, useMemo, useRef } from "react";
import { useContinuousAnimationGate } from "@/shared/hooks/use-continuous-animation-gate";
import { useExclusiveAnimation } from "@/shared/hooks/use-exclusive-animation";
import "./text-shimmer.css";

interface TextShimmerProps {
  text: string;
  /** Whether shimmer is actively running */
  active?: boolean;
  className?: string;
  /** Fixed sweep duration; when omitted, scales with text length. */
  durationMs?: number;
  /** Anchor the sweep phase to a shared wall clock across separate mounts. */
  syncPhase?: boolean;
  /** At most one visible candidate in this group receives the sweep. */
  exclusiveGroup?: string;
  /** Higher-priority visible candidates own their group's single sweep. */
  exclusivePriority?: number;
}

export const CHAT_ACTIVITY_SHIMMER_GROUP = "chat-activity";

export function TextShimmer({
  text,
  active = true,
  className,
  durationMs,
  syncPhase = false,
  exclusiveGroup,
  exclusivePriority = 0,
}: TextShimmerProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const sweepRef = useRef<HTMLSpanElement>(null);
  const sweepTextRef = useRef<HTMLSpanElement>(null);
  const duration = useMemo(() => {
    if (durationMs !== undefined) return durationMs;
    const perCharMs = 95;
    return Math.max(1400, Math.min(4000, text.length * perCharMs));
  }, [durationMs, text.length]);
  const animationGateOpen = useContinuousAnimationGate({
    active,
    elementRef: rootRef,
  });
  const shouldAnimate = useExclusiveAnimation(
    exclusiveGroup,
    animationGateOpen,
    exclusivePriority,
  );

  useEffect(() => {
    if (!shouldAnimate || !sweepRef.current || !sweepTextRef.current) return;
    const sweep = sweepRef.current;
    const sweepText = sweepTextRef.current;
    if (
      typeof sweep.animate !== "function" ||
      typeof sweepText.animate !== "function"
    ) {
      return;
    }
    const sweepDuration = Math.min(900, Math.max(650, duration * 0.35));
    const restDuration = Math.max(3000, duration * 1.5);
    let stopped = false;
    let timerId: number | undefined;
    let animations: Animation[] = [];

    const runSweep = () => {
      if (stopped) return;
      animations = [
        sweep.animate(
          [
            { transform: "translate3d(-100%, 0, 0)" },
            { transform: "translate3d(calc(100% / 0.28), 0, 0)" },
          ],
          { duration: sweepDuration, easing: "ease-in-out" },
        ),
        sweepText.animate(
          [
            { transform: "translate3d(28%, 0, 0)" },
            { transform: "translate3d(-100%, 0, 0)" },
          ],
          { duration: sweepDuration, easing: "ease-in-out" },
        ),
      ];
      void Promise.all(animations.map((animation) => animation.finished))
        .catch(() => undefined)
        .then(() => {
          if (!stopped) timerId = window.setTimeout(runSweep, restDuration);
        });
    };

    const initialDelay = syncPhase ? duration - (Date.now() % duration) : 0;
    if (initialDelay > 0) timerId = window.setTimeout(runSweep, initialDelay);
    else runSweep();
    return () => {
      stopped = true;
      if (timerId !== undefined) window.clearTimeout(timerId);
      for (const animation of animations) animation.cancel();
    };
  }, [duration, shouldAnimate, syncPhase]);

  if (!active) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span
      ref={rootRef}
      className={`text-shimmer${shouldAnimate ? " text-shimmer--active" : ""}${className ? ` ${className}` : ""}`}
    >
      <span className="text-shimmer__base">{text}</span>
      {shouldAnimate ? (
        <span ref={sweepRef} className="text-shimmer__sweep" aria-hidden="true">
          <span ref={sweepTextRef} className="text-shimmer__sweep-text">
            {text}
          </span>
        </span>
      ) : null}
    </span>
  );
}
