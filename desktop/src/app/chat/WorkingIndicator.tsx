import { useEffect, useState } from "react";
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
  // Defer StellaAnimation mount so WebGL shader compilation doesn't block
  // the first streaming frames. The text status renders immediately.
  const [animReady, setAnimReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  let displayStatus: string;
  const activeTask = tasks?.[0];
  const shimmerActive = !activeTask || activeTask.status === "running";

  if (status) {
    displayStatus = status;
  } else if (tasks && tasks.length > 0) {
    const task = tasks[0];
    const taskText = task.statusText ?? task.description;
    if (task.status === "completed") {
      displayStatus = taskText ? `Task complete \u00b7 ${taskText}` : "Task complete";
    } else {
      const label = getAgentLabel(task.agentType);
      displayStatus = taskText ? `${label} \u00b7 ${taskText}` : label;
    }
  } else {
    displayStatus = computeStatus({ toolName, isReasoning, isResponding });
  }

  return (
    <div className={cn("working-indicator", className)}>
      <div className="indicator-stella">
        <div className="indicator-stella-scale">
          {animReady && <StellaAnimation width={20} height={20} maxDpr={1} frameSkip={2} />}
        </div>
      </div>
      <TextShimmer
        text={displayStatus}
        active={shimmerActive}
        className="working-status"
      />
      {duration && (
        <>
          <span className="working-separator">{"\u00b7"}</span>
          <span className="working-duration">{duration}</span>
        </>
      )}
    </div>
  );
}




