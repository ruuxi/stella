import { cn } from "@/lib/utils";
import { Spinner } from "../spinner";
import type { TaskItem } from "../../hooks/use-conversation-events";

interface TaskIndicatorProps {
  tasks: TaskItem[];
  className?: string;
}

// Get a friendly label for agent types
const getAgentLabel = (agentType: string): string => {
  switch (agentType) {
    case "general":
      return "Working";
    case "explore":
      return "Exploring";
    case "browser":
      return "Browsing";
    case "self_mod":
      return "Modifying";
    case "orchestrator":
      return "Coordinating";
    default:
      return agentType;
  }
};

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
