/**
 * TextShimmer: animated gradient shimmer across the entire string.
 */

import { useMemo, useRef } from "react";
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
}

export function TextShimmer({
  text,
  active = true,
  className,
  durationMs,
  syncPhase = false,
  exclusiveGroup,
}: TextShimmerProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const duration = useMemo(() => {
    if (durationMs !== undefined) return durationMs;
    const perCharMs = 95;
    return Math.max(1400, Math.min(4000, text.length * perCharMs));
  }, [durationMs, text.length]);
  const phaseDelayMs = useMemo(
    () => (syncPhase ? -(Date.now() % duration) : 0),
    [duration, syncPhase],
  );
  const animationGateOpen = useContinuousAnimationGate({
    active,
    elementRef: rootRef,
  });
  const shouldAnimate = useExclusiveAnimation(
    exclusiveGroup,
    animationGateOpen,
  );

  if (!active) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span
      ref={rootRef}
      className={`text-shimmer${shouldAnimate ? " text-shimmer--active" : ""}${className ? ` ${className}` : ""}`}
      style={
        {
          "--text-shimmer-duration": `${duration}ms`,
          "--text-shimmer-delay": `${phaseDelayMs}ms`,
        } as React.CSSProperties
      }
    >
      <span className="text-shimmer__base">{text}</span>
      {shouldAnimate ? (
        <span className="text-shimmer__sweep" aria-hidden="true">
          <span className="text-shimmer__sweep-text">{text}</span>
        </span>
      ) : null}
    </span>
  );
}
