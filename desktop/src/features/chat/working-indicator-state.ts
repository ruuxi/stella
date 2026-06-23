import type { TaskItem } from "@/features/chat/lib/event-transforms";
import {
  isStandaloneTaskStatusText,
  normalizeTaskDisplayStatusText,
} from "@/features/chat/lib/event-transforms";
import { computeStatus, normalizeDisplayStatusText } from "./status-utils";

export const INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS = 2000;

export function getRunningTaskIndicatorText(
  task: TaskItem,
): string | undefined {
  if (task.status !== "running") return undefined;
  const statusText = normalizeTaskDisplayStatusText(task.statusText);
  if (!statusText) return undefined;
  if (statusText === task.description.trim()) return undefined;
  return statusText;
}

export function getInlineWorkingIndicatorActive({
  isStreaming,
  isStreamingResponseText,
  isToolActive,
  hasRunningTask,
}: {
  isStreaming: boolean;
  isStreamingResponseText: boolean;
  isToolActive: boolean;
  /**
   * A spawned agent/task is currently running. Its own task chip and
   * per-agent indicator cover that work, so the orchestrator line should
   * not pin "thinking" while it merely waits for the sub-agent.
   */
  hasRunningTask: boolean;
}): boolean {
  if (isToolActive) return true;
  // The orchestrator is between its own steps: the initial pre-tool think,
  // or the gap after a fast tool returns before the next tool/answer. Show
  // the rotating thinking label so the line never goes blank mid-run — but
  // not while a spawned agent is doing the work.
  return isStreaming && !isStreamingResponseText && !hasRunningTask;
}

export function getInlineWorkingIndicatorExitDelayMs({
  activatedAtMs,
  nowMs,
  minVisibleMs = INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS,
}: {
  activatedAtMs: number;
  nowMs: number;
  minVisibleMs?: number;
}): number {
  return Math.max(0, minVisibleMs - (nowMs - activatedAtMs));
}

export function getWorkingIndicatorDisplayStatus({
  status,
  toolName,
  toolCallId,
  tasks,
  isReasoning,
  reasoningSeed,
}: {
  status?: string;
  toolName?: string;
  toolCallId?: string;
  tasks?: TaskItem[];
  isReasoning?: boolean;
  /** Per-turn seed for the no-tool reasoning/idle label so it rotates
   * across turns instead of always reading "Thinking". */
  reasoningSeed?: string;
}): string {
  if (status) {
    return normalizeDisplayStatusText(status) ?? status;
  }

  if (tasks && tasks.length > 0) {
    const task = tasks[0];
    if (task.status === "completed") {
      const taskText = normalizeTaskDisplayStatusText(task.statusText);
      return taskText ? `Done · ${taskText}` : "Done";
    }
    if (task.status === "running") {
      const statusText = getRunningTaskIndicatorText(task);
      if (statusText && !isStandaloneTaskStatusText(statusText)) {
        return statusText;
      }
      if (statusText && isStandaloneTaskStatusText(statusText)) {
        return statusText;
      }
      if (toolName) {
        return computeStatus({ toolName, seed: toolCallId });
      }
      return computeStatus({ toolName: "spawn_agent", seed: "" });
    }
  }

  return computeStatus({
    toolName,
    seed: toolCallId ?? reasoningSeed,
    isReasoning,
  });
}
