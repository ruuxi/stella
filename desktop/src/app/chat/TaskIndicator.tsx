import { cn } from "@/shared/lib/utils";
import type { TaskItem } from "@/app/chat/lib/event-transforms";
import { getAgentLabel } from "./agent-labels";
import { StellaAnimation } from "@/shell/ascii-creature/StellaAnimation";
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
          <div className="indicator-stella">
            <div className="indicator-stella-scale">
              <StellaAnimation width={20} height={20} maxDpr={1} frameSkip={2} />
            </div>
          </div>
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




