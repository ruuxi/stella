/**
 * Inline working indicator — the Claude-style "next-line" indicator.
 *
 * Mounted (persistently) at the top of the `ChatTimeline` footer
 * (`.event-list-working-indicator`), so it reads as the line directly
 * below the streaming/last assistant message and above any queued user
 * messages.
 *
 * Behavior:
 *  - While the assistant is reasoning (no answer text yet) it reads
 *    "Thinking"; while a tool is running it shows that tool's friendly
 *    status. The moment answer text starts streaming, the indicator
 *    exits — it does NOT trail the growing message line by line.
 *  - Long-running agent task presence lives in the composer's task chip; this
 *    inline indicator only follows the orchestrator's thinking/tool lifecycle.
 *  - When the work finishes (`active` flips false) the indicator stays visible
 *    for at least `MIN_VISIBLE_MS`, then plays a short grow-out/fade for
 *    `EXIT_ANIMATION_MS` showing its last-known label. The parent mounts the
 *    indicator unconditionally and toggles `active` so React doesn't rip
 *    the node out before the exit animation runs. If `active` flips back
 *    true mid-exit, the exit is canceled and live updates resume.
 *  - Once fully exited, the inner content is removed (`--vacated`); the
 *    footer wrapper's `:has(--vacated)` rule then collapses the slot so an
 *    idle chat carries no ghost gutter.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getInlineWorkingIndicatorExitDelayMs,
  INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS,
} from "@/features/chat/working-indicator-state";
import { WorkingIndicator } from "./WorkingIndicator";
import "./indicators.css";

export type InlineWorkingIndicatorProps = {
  runningTool?: string;
  /** Stable id of the in-flight tool call; seeds the friendly status
   * label so it doesn't churn on every re-render. */
  runningToolId?: string;
  /** Run-level orchestrator status (spawn / pause / compaction, etc.). */
  status?: string | null;
};

export type InlineWorkingIndicatorMountProps = InlineWorkingIndicatorProps & {
  /**
   * `true` while the orchestrator is thinking or running a tool (and not
   * yet streaming answer text). Flipping to `false` triggers the grow-out
   * exit; the component stays mounted until the exit completes. If
   * `active` flips back to true mid-exit, the exit is canceled and the
   * indicator resumes live updates.
   */
  active: boolean;
};

/**
 * Exit timing. There's no hold beat anymore (the indicator used to linger
 * to show a "Done · task" state) — once work stops we want the indicator
 * gone promptly, with just a short grow-out so it doesn't snap away.
 */
const EXIT_ANIMATION_MS = 240;
const MIN_VISIBLE_MS = INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS;

export function InlineWorkingIndicator({
  active,
  runningTool,
  runningToolId,
  status,
}: InlineWorkingIndicatorMountProps) {
  // Snapshot the live props the moment `active` flips false so the exit
  // animation displays a stable last-known label even though upstream
  // tool/status flags clear out.
  const liveProps = useMemo<InlineWorkingIndicatorProps>(
    () => ({ runningTool, runningToolId, status }),
    [runningTool, runningToolId, status],
  );
  const frozenPropsRef = useRef<InlineWorkingIndicatorProps>(liveProps);

  useEffect(() => {
    if (active) {
      frozenPropsRef.current = liveProps;
    }
  }, [active, liveProps]);

  const displayProps = active ? liveProps : frozenPropsRef.current;

  // Stay mounted until the exit animation finishes. If `active` flips back
  // to true mid-animation, cancel the exit and resume live updates.
  const [renderShell, setRenderShell] = useState(active);
  const [leaving, setLeaving] = useState(false);
  const exitTimerRef = useRef<number | null>(null);
  const activatedAtRef = useRef<number | null>(active ? Date.now() : null);
  const wasActiveRef = useRef(active);

  useEffect(() => {
    const clearTimer = () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };

    if (active) {
      clearTimer();
      if (!wasActiveRef.current) {
        activatedAtRef.current = Date.now();
      }
      wasActiveRef.current = true;
      setLeaving(false);
      setRenderShell(true);
      return;
    }

    wasActiveRef.current = false;
    if (!renderShell) return;

    const startExit = () => {
      setLeaving(true);
      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = null;
        setRenderShell(false);
        setLeaving(false);
      }, EXIT_ANIMATION_MS);
    };
    const activatedAt = activatedAtRef.current ?? Date.now();
    const remainingMs = getInlineWorkingIndicatorExitDelayMs({
      activatedAtMs: activatedAt,
      nowMs: Date.now(),
      minVisibleMs: MIN_VISIBLE_MS,
    });
    if (remainingMs > 0) {
      exitTimerRef.current = window.setTimeout(startExit, remainingMs);
    } else {
      startExit();
    }

    return () => {
      clearTimer();
    };
  }, [active, renderShell]);

  // The wrapper itself is always rendered with a fixed height once the
  // indicator has appeared — `renderShell` only gates the inner content,
  // so the gutter the indicator carved out below the assistant message
  // remains after the grow-out exit completes (no layout shift). A new
  // turn replaces the wrapper entirely (different React key in
  // `ChatTimeline`), at which point the new wrapper occupies the slot.
  const showInner = renderShell;

  return (
    <div
      className={`inline-working-indicator${leaving ? " inline-working-indicator--leaving" : ""}${showInner ? "" : " inline-working-indicator--vacated"}`}
      aria-live="polite"
    >
      {showInner && (
        <WorkingIndicator
          className="inline-working-indicator__indicator"
          status={displayProps.status ?? undefined}
          toolName={displayProps.runningTool}
          toolCallId={displayProps.runningToolId}
          isReasoning={!displayProps.runningTool}
        />
      )}
    </div>
  );
}
