import { useEffect, useMemo, useState } from "react";
import type { TaskItem } from "@/app/chat/lib/event-transforms";
import { WorkingIndicator } from "./WorkingIndicator";
import "./indicators.css";

const TASK_ROTATE_MS = 1800;

type StickyThinkingFooterProps = {
  tasks: TaskItem[];
  runningTool?: string;
  isStreaming?: boolean;
  status?: string | null;
};

export function StickyThinkingFooter({
  tasks,
  runningTool,
  isStreaming,
  status,
}: StickyThinkingFooterProps) {
  const runningTasks = useMemo(
    () => tasks.filter((task) => task.status === "running"),
    [tasks],
  );
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
  }, [runningTasks.length]);

  useEffect(() => {
    if (runningTasks.length <= 1) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % runningTasks.length);
    }, TASK_ROTATE_MS);

    return () => window.clearInterval(intervalId);
  }, [runningTasks]);

  const activeTask =
    runningTasks.length > 0
      ? runningTasks[activeIndex % runningTasks.length]
      : null;

  if (!activeTask && !isStreaming) {
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
          status={status ?? undefined}
          tasks={activeTask ? [activeTask] : undefined}
          toolName={runningTool}
          isReasoning={!activeTask}
        />
      </div>
    </div>
  );
}
