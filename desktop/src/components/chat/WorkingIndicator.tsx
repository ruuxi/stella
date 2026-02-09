import { Spinner } from "../spinner";
import { cn } from "@/lib/utils";
import { computeStatus } from "./status-utils";
import type { TaskItem } from "../../hooks/use-conversation-events";

interface WorkingIndicatorProps {
  status?: string;
  toolName?: string;
  tasks?: TaskItem[];
  isReasoning?: boolean;
  isResponding?: boolean;
  duration?: string;
  className?: string;
}

const getAgentLabel = (agentType: string): string => {
  switch (agentType) {
    case "general":
      return "Working";
    case "memory":
      return "Searching memory";
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

export function WorkingIndicator({
  status,
  toolName,
  tasks,
  isReasoning,
  isResponding,
  duration,
  className,
}: WorkingIndicatorProps) {
  let displayStatus: string;

  if (status) {
    displayStatus = status;
  } else if (tasks && tasks.length > 0) {
    const task = tasks[0];
    const label = getAgentLabel(task.agentType);
    displayStatus = task.description ? `${label} \u00b7 ${task.description}` : label;
  } else {
    displayStatus = computeStatus({ toolName, isReasoning, isResponding });
  }

  return (
    <div className={cn("working-indicator", className)}>
      <Spinner size="sm" />
      <span className="working-status">{displayStatus}</span>
      {duration && (
        <>
          <span className="working-separator">{"\u00b7"}</span>
          <span className="working-duration">{duration}</span>
        </>
      )}
    </div>
  );
}
