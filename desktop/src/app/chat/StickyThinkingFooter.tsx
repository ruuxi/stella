import { useEffect, useMemo, useState } from "react";
import type { TaskItem } from "@/app/chat/lib/event-transforms";
import { WorkingIndicator } from "./WorkingIndicator";
import {
  getStickyThinkingFooterState,
  TASK_ROTATE_MS,
} from "./sticky-thinking-footer-state";
import "./indicators.css";

type StickyThinkingFooterProps = {
  tasks: TaskItem[];
  runningTool?: string;
  /** Stable id of the in-flight tool call; used as a seed so the friendly
   * status label stays put for the duration of one call. */
  runningToolId?: string;
  isStreaming?: boolean;
  status?: string | null;
};

export function StickyThinkingFooter({
  tasks,
  runningTool,
  runningToolId,
  isStreaming,
  status,
}: StickyThinkingFooterProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const footerState = useMemo(
    () =>
      getStickyThinkingFooterState({
        tasks,
        activeIndex,
        isStreaming,
        status,
      }),
    [activeIndex, isStreaming, status, tasks],
  );
  const { activeTask, displayTasks } = footerState;

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

  if (!footerState.shouldRender) {
    return null;
  }

  return (
    <div className="sticky-thinking-footer" aria-live="polite">
      <div
        key={activeTask?.id ?? runningTool ?? "thinking"}
        className="sticky-thinking-footer__content"
      >
        <WorkingIndicator
          className="sticky-thinking-footer__indicator"
          status={footerState.status}
          tasks={activeTask ? [activeTask] : undefined}
          toolName={runningTool}
          toolCallId={runningToolId}
          isReasoning={!activeTask}
        />
      </div>
    </div>
  );
}
