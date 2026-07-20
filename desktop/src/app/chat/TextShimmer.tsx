/**
 * TextShimmer: animated gradient shimmer across the entire string.
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import { useContinuousAnimationGate } from "@/shared/hooks/use-continuous-animation-gate";
import { useExclusiveAnimation } from "@/shared/hooks/use-exclusive-animation";
import { createDemandDrivenAnimationLoop } from "@/shared/lib/demand-driven-animation-loop";
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
const SHIMMER_MAX_FPS = 15;

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

  useLayoutEffect(() => {
    if (!shouldAnimate || !sweepRef.current || !sweepTextRef.current) return;
    const startedAt = performance.now();
    const initialElapsed = syncPhase ? Date.now() % duration : 0;
    const loop = createDemandDrivenAnimationLoop({
      maxFramesPerSecond: SHIMMER_MAX_FPS,
      onFrame: (time) => {
        const phase =
          ((initialElapsed + time - startedAt) % duration) / duration;
        sweepRef.current?.style.setProperty(
          "transform",
          `translate3d(${-100 + phase * (100 + 100 / 0.28)}%, 0, 0)`,
        );
        sweepTextRef.current?.style.setProperty(
          "transform",
          `translate3d(${28 - phase * 128}%, 0, 0)`,
        );
      },
    });
    loop.start();
    return loop.stop;
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
