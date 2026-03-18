import { cn } from "@/shared/lib/utils";
import { computeStatus } from "./status-utils";
import type { TaskItem } from "@/app/chat/lib/event-transforms";
import { getAgentLabel } from "./agent-labels";
import { StellaAnimation } from "@/shell/ascii-creature/StellaAnimation";
import { TextShimmer } from "./TextShimmer";
import "./indicators.css";

interface WorkingIndicatorProps {
  status?: string;
  toolName?: string;
  tasks?: TaskItem[];
  isReasoning?: boolean;
  isResponding?: boolean;
  duration?: string;
  className?: string;
}

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
      <div className="indicator-stella">
        <div className="indicator-stella-scale">
          <StellaAnimation width={20} height={20} maxDpr={1} frameSkip={2} />
        </div>
      </div>
      <TextShimmer text={displayStatus} active={true} className="working-status" />
      {duration && (
        <>
          <span className="working-separator">{"\u00b7"}</span>
          <span className="working-duration">{duration}</span>
        </>
      )}
    </div>
  );
}




