import type { TaskItem } from "@/app/chat/lib/event-transforms";
import {
  getTaskWorkingIndicatorText,
  isStandaloneTaskStatusText,
} from "@/app/chat/lib/event-transforms";
import { getAgentLabel } from "./agent-labels";
import { computeStatus } from "./status-utils";

export function getWorkingIndicatorDisplayStatus({
  status,
  toolName,
  toolCallId,
  tasks,
  isReasoning,
}: {
  status?: string;
  toolName?: string;
  toolCallId?: string;
  tasks?: TaskItem[];
  isReasoning?: boolean;
}): string {
  if (status) {
    return status;
  }

  if (tasks && tasks.length > 0) {
    const task = tasks[0];
    const taskText = getTaskWorkingIndicatorText(task);
    if (task.status === "completed") {
      return taskText ? `Done · ${taskText}` : "Done";
    }
    if (task.status === "running" && isStandaloneTaskStatusText(task.statusText)) {
      return taskText || getAgentLabel(task.agentType);
    }
    const label = getAgentLabel(task.agentType);
    if (taskText) {
      return `${label} · ${taskText}`;
    }
    // Task is running but has no usable subtitle yet (e.g. agent-started arrived
    // before the first agent-progress and the description was generic). Prefer
    // an orchestrator tool line over a bare "Working" label.
    if (toolName) {
      return `${label} · ${computeStatus({ toolName, seed: toolCallId })}`;
    }
    return label;
  }

  return computeStatus({ toolName, seed: toolCallId, isReasoning });
}
