import { cn } from "@/lib/utils";
import { Spinner } from "@/ui/spinner";
import type { TaskItem } from "@/lib/event-transforms";
import { getAgentLabel } from "./agent-labels";
import "./indicators.css";

interface TaskIndicatorProps {
  tasks: TaskItem[];
  className?: string;
}

export function TaskIndicator({ tasks, className }: TaskIndicatorProps) {
  // Only show running tasks
  const runningTasks = tasks.filter((t) => t.status === "running");

  if (runningTasks.length === 0) {
    return null;
  }

  return (
    <div className={cn("task-indicator", className)}>
      {runningTasks.map((task) => (
        <div key={task.id} className="task-indicator-item">
          <Spinner size="sm" />
          <div className="task-indicator-content">
            <span className="task-indicator-label">
              {getAgentLabel(task.agentType)}
            </span>
            <span className="task-indicator-description">
              {task.statusText ?? task.description}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}


