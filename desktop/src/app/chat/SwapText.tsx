/**
 * SwapText: crossfades + slides between text values when `text` changes.
 *
 * Used by the working indicator so that transitions like
 *   Working · X → Updating · X → Working · X
 * and multi-agent rotation row swaps animate instead of snapping.
 *
 * Width changes are not explicitly animated; the grid stack keeps both
 * layers in the same cell during the transition (cell sizes to the
 * larger of the two), then snaps to the new content's natural width
 * once the outgoing layer is unmounted. In the sticky footer the
 * surrounding flex container absorbs that final size change without
 * shifting layout.
 */

import { useEffect, useRef, useState } from "react";
import { TextShimmer } from "./TextShimmer";

interface SwapTextProps {
  text: string;
  active?: boolean;
  /** Let a parent-owned entrance animation reveal the initial text as part of
   * one atomic surface, while preserving animated swaps after it changes. */
  animateInitial?: boolean;
  className?: string;
  shimmerGroup?: string;
  shimmerPriority?: number;
}

const SWAP_DURATION_MS = 240;

export function SwapText({
  text,
  active = true,
  animateInitial = true,
  className,
  shimmerGroup,
  shimmerPriority,
}: SwapTextProps) {
  const [current, setCurrent] = useState(text);
  const [previous, setPrevious] = useState<string | null>(null);
  const [hasChanged, setHasChanged] = useState(false);
  const lastTextRef = useRef(text);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (text === lastTextRef.current) {
      return;
    }
    setPrevious(lastTextRef.current);
    setCurrent(text);
    setHasChanged(true);
    lastTextRef.current = text;

    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = window.setTimeout(() => {
      setPrevious(null);
      timeoutRef.current = null;
    }, SWAP_DURATION_MS);

    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [text]);

  return (
    <span className={`swap-text ${className ?? ""}`}>
      {previous !== null && (
        <span
          key={`out:${previous}`}
          className="swap-text__layer swap-text__layer--out"
          aria-hidden="true"
        >
          {previous}
        </span>
      )}
      <span
        key={`in:${current}`}
        className={`swap-text__layer swap-text__layer--in${!animateInitial && !hasChanged ? " swap-text__layer--initial-static" : ""}`}
      >
        <TextShimmer
          text={current}
          active={active}
          exclusiveGroup={shimmerGroup}
          exclusivePriority={shimmerPriority}
        />
      </span>
    </span>
  );
}
