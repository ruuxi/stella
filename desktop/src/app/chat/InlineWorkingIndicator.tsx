/**
 * Inline working indicator — the Claude-style "next-line" indicator that
 * lives as the next sibling after the latest animating assistant row.
 *
 * Behavior:
 *  - Renders just below the streaming assistant bubble so as text streams
 *    in line by line the indicator naturally moves down with each new
 *    line (the bubble grows, this sibling moves with it).
 *  - When the work finishes (`active` flips false), the indicator stays
 *    on screen for `EXIT_HOLD_MS` showing its last-known label, then
 *    plays a grow-out/fade for `EXIT_ANIMATION_MS` before unmount. The
 *    parent passes the indicator unconditionally and toggles `active`
 *    so React doesn't rip the node out before the exit animation runs.
 *  - When a brand-new turn begins (the host row remounts under a new
 *    React key), this component remounts at the new anchor and plays
 *    its enter animation; the previous instance keeps animating its
 *    exit at the old DOM position.
 *
 * The component owns the multi-task rotation interval so the parent
 * timeline doesn't have to.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskItem } from "@/app/chat/lib/event-transforms";
import { WorkingIndicator } from "./WorkingIndicator";
import {
  getStickyThinkingFooterState,
  TASK_ROTATE_MS,
} from "./sticky-thinking-footer-state";
import "./indicators.css";

export type InlineWorkingIndicatorProps = {
  tasks: TaskItem[];
  runningTool?: string;
  /** Stable id of the in-flight tool call; seeds the friendly status
   * label so it doesn't churn on every re-render. */
  runningToolId?: string;
  isStreaming?: boolean;
  status?: string | null;
};

export type InlineWorkingIndicatorMountProps = InlineWorkingIndicatorProps & {
  /**
   * `true` while the runtime is reporting active work. Flipping to
   * `false` triggers the hold + grow-out exit; the component stays
   * mounted until the exit completes. If `active` flips back to true
   * mid-hold (e.g. another tool kicks off), the exit is canceled and
   * the indicator resumes live updates.
   */
  active: boolean;
};

/**
 * Hold the indicator on screen for a beat after `active` flips false,
 * then play a longer grow-out/fade-out so it doesn't snap away the
 * instant the assistant finishes. The hold is invisible — the shimmer
 * and label just settle for a moment before the indicator gracefully
 * shrinks and fades.
 */
const EXIT_HOLD_MS = 1000;
const EXIT_ANIMATION_MS = 480;

export function InlineWorkingIndicator({
  active,
  tasks,
  runningTool,
  runningToolId,
  isStreaming,
  status,
}: InlineWorkingIndicatorMountProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  // Snapshot the live props the moment `active` flips false so the
  // exit animation displays a stable last-known label / shimmer state
  // even though upstream tasks/streaming flags clear out.
  const liveProps = useMemo<InlineWorkingIndicatorProps>(
    () => ({ tasks, runningTool, runningToolId, isStreaming, status }),
    [isStreaming, runningTool, runningToolId, status, tasks],
  );
  const frozenPropsRef = useRef<InlineWorkingIndicatorProps>(liveProps);
  if (active) {
    frozenPropsRef.current = liveProps;
  }
  const displayProps = active ? liveProps : frozenPropsRef.current;

  const indicatorState = useMemo(
    () =>
      getStickyThinkingFooterState({
        tasks: displayProps.tasks,
        activeIndex,
        isStreaming: displayProps.isStreaming,
        status: displayProps.status,
      }),
    [activeIndex, displayProps.isStreaming, displayProps.status, displayProps.tasks],
  );
  const { activeTask, displayTasks } = indicatorState;

  useEffect(() => {
    setActiveIndex(0);
  }, [displayTasks.length]);

  useEffect(() => {
    if (displayTasks.length <= 1) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % displayTasks.length);
    }, TASK_ROTATE_MS);

    return () => window.clearInterval(intervalId);
  }, [displayTasks]);

  // Stay mounted until the exit animation finishes. Two staged
  // timeouts: hold → leave → unmount. If `active` flips back to true
  // mid-hold or mid-animation, cancel both and resume live updates.
  const [renderShell, setRenderShell] = useState(active);
  const [leaving, setLeaving] = useState(false);
  const exitHoldTimerRef = useRef<number | null>(null);
  const exitUnmountTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimers = () => {
      if (exitHoldTimerRef.current !== null) {
        window.clearTimeout(exitHoldTimerRef.current);
        exitHoldTimerRef.current = null;
      }
      if (exitUnmountTimerRef.current !== null) {
        window.clearTimeout(exitUnmountTimerRef.current);
        exitUnmountTimerRef.current = null;
      }
    };

    if (active) {
      clearTimers();
      setLeaving(false);
      setRenderShell(true);
      return;
    }

    if (!renderShell) return;

    exitHoldTimerRef.current = window.setTimeout(() => {
      exitHoldTimerRef.current = null;
      setLeaving(true);
      exitUnmountTimerRef.current = window.setTimeout(() => {
        exitUnmountTimerRef.current = null;
        setRenderShell(false);
        setLeaving(false);
      }, EXIT_ANIMATION_MS);
    }, EXIT_HOLD_MS);

    return () => {
      clearTimers();
    };
  }, [active, renderShell]);

  // The wrapper itself is always rendered with a fixed height once the
  // indicator has appeared — `renderShell` only gates the inner content,
  // so the gutter the indicator carved out below the assistant message
  // remains after the grow-out exit completes (no layout shift). A new
  // turn replaces the wrapper entirely (different React key in
  // `ChatTimeline`), at which point the new wrapper occupies the slot.
  const showInner = renderShell && indicatorState.shouldRender;

  return (
    <div
      className={`inline-working-indicator${leaving ? " inline-working-indicator--leaving" : ""}${showInner ? "" : " inline-working-indicator--vacated"}`}
      aria-live="polite"
    >
      {showInner && (
        <WorkingIndicator
          className="inline-working-indicator__indicator"
          status={indicatorState.status}
          tasks={activeTask ? [activeTask] : undefined}
          toolName={displayProps.runningTool}
          toolCallId={displayProps.runningToolId}
          isReasoning={!activeTask}
        />
      )}
    </div>
  );
}
