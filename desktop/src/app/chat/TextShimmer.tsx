/**
 * TextShimmer: animated gradient shimmer across the entire string.
 */

import { useMemo } from "react";
import "./text-shimmer.css";

interface TextShimmerProps {
  text: string;
  /** Whether shimmer is actively running */
  active?: boolean;
  className?: string;
  /** Fixed sweep duration; when omitted, scales with text length. */
  durationMs?: number;
}

export function TextShimmer({
  text,
  active = true,
  className,
  durationMs,
}: TextShimmerProps) {
  const duration = useMemo(() => {
    if (durationMs !== undefined) return durationMs;
    const perCharMs = 95;
    return Math.max(1400, Math.min(4000, text.length * perCharMs));
  }, [durationMs, text.length]);

  if (!active) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span
      className={`text-shimmer ${className ?? ""}`}
      style={
        {
          "--text-shimmer-duration": `${duration}ms`,
        } as React.CSSProperties
      }
    >
      {text}
    </span>
  );
}
