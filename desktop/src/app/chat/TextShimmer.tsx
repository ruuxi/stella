/**
 * TextShimmer: Per-character shimmer sweep animation.
 * Each character gets a staggered animation delay for an organic wave effect.
 */

import { useMemo } from "react";
import "./text-shimmer.css";

interface TextShimmerProps {
  text: string;
  /** Whether shimmer is actively running */
  active?: boolean;
  className?: string;
}

const STEP_MS = 45; // delay between each character's animation start

export function TextShimmer({
  text,
  active = true,
  className,
}: TextShimmerProps) {
  const chars = useMemo(() => text.split(""), [text]);

  // Duration scales with text length to keep velocity constant
  const duration = useMemo(() => {
    const velocity = 0.01375; // ch/ms — matches OpenCode
    const len = chars.length;
    const size = 2; // background-size multiplier
    return Math.max(800, len * (size - 1) / velocity);
  }, [chars.length]);

  if (!active) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span
      className={`text-shimmer ${className ?? ""}`}
      style={{
        "--text-shimmer-duration": `${duration}ms`,
        "--text-shimmer-step": `${STEP_MS}ms`,
      } as React.CSSProperties}
    >
      {chars.map((char, i) => (
        <span
          key={i}
          className="text-shimmer-char"
          style={{
            "--text-shimmer-index": i,
          } as React.CSSProperties}
        >
          {char === " " ? "\u00A0" : char}
        </span>
      ))}
    </span>
  );
}
