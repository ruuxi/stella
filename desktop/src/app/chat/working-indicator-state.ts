import type { TaskItem } from "@/app/chat/lib/event-transforms";
import { getAgentLabel } from "./agent-labels";
import { computeStatus } from "./status-utils";

const STANDALONE_STATUS_TEXT = new Set(["Updating", "Pausing", "Queued"]);
const getDisplayableTaskDescription = (description: string): string =>
  description === "Task" ? "" : description;

export function getWorkingIndicatorDisplayStatus({
  status,
  toolName,
  tasks,
  isReasoning,
}: {
  status?: string;
  toolName?: string;
  tasks?: TaskItem[];
  isReasoning?: boolean;
}): string {
  if (status) {
    return status;
  }

  if (tasks && tasks.length > 0) {
    const task = tasks[0];
    if (task.status === "running" && task.statusText && STANDALONE_STATUS_TEXT.has(task.statusText)) {
      const description = getDisplayableTaskDescription(task.description);
      return description ? `${task.statusText} · ${description}` : task.statusText;
    }
    const taskText =
      task.status === "running"
        ? (task.statusText ?? getDisplayableTaskDescription(task.description))
        : task.description;
    if (task.status === "completed") {
      return taskText ? `Done · ${taskText}` : "Done";
    }
    const label = getAgentLabel(task.agentType);
    return taskText ? `${label} · ${taskText}` : label;
  }

  return computeStatus({ toolName, isReasoning });
}
