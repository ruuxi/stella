import type { TaskItem } from "@/features/chat/lib/event-transforms";
import {
  isStandaloneTaskStatusText,
  normalizeTaskDisplayStatusText,
} from "@/features/chat/lib/event-transforms";
import { computeStatus, normalizeDisplayStatusText } from "./status-utils";

export const INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS = 2000;

export type InlineWorkingIndicatorProps = {
  runningTool?: string;
  /** Stable id of the in-flight tool call; seeds the friendly status
   * label so it doesn't churn on every re-render. */
  runningToolId?: string;
  /** Run-level orchestrator status (spawn / pause / compaction, etc.). */
  status?: string | null;
};

export type InlineWorkingIndicatorMountProps = InlineWorkingIndicatorProps & {
  /**
   * `true` while the orchestrator is thinking or running a tool (and not
   * yet streaming answer text). Flipping to `false` triggers the grow-out
   * exit; the component stays mounted until the exit completes. If
   * `active` flips back to true mid-exit, the exit is canceled and the
   * indicator resumes live updates.
   */
  active: boolean;
  /**
   * Skip the `MIN_VISIBLE_MS` hold on deactivation. Set when answer text
   * has started streaming — the indicator must get out of the way right
   * away instead of trailing the growing message for the hold duration.
   */
  exitImmediately?: boolean;
};

/**
 * Single source of truth for the inline working indicator's mount props,
 * shared by every chat surface (full shell, sidebar, mini) so they can't
 * drift. Pass the raw streaming snapshot; the helper derives `active`,
 * the friendly label inputs, and the immediate-exit handoff.
 */
export function buildInlineWorkingIndicatorProps({
  isStreaming,
  isStreamingResponseText,
  isToolActive,
  hasToolActivity,
  activeToolName,
  activeToolCallId,
  runtimeStatusText,
  liveTasks,
  coverSubAgentWork = false,
}: {
  isStreaming: boolean;
  isStreamingResponseText: boolean;
  isToolActive: boolean;
  hasToolActivity: boolean;
  activeToolName?: string | null;
  activeToolCallId?: string | null;
  runtimeStatusText?: string | null;
  liveTasks?: TaskItem[];
  /**
   * Surfaces without a composer activity pill (the sidebar + mini window)
   * have nowhere else to show that a spawned agent is working, so the
   * inline indicator must cover that case rather than step aside. The full
   * shell passes `false` because its `ComposerActivityPill` owns that
   * state.
   */
  coverSubAgentWork?: boolean;
}): InlineWorkingIndicatorMountProps {
  const hasRunningTask =
    !coverSubAgentWork &&
    (liveTasks ?? []).some((task) => task.status === "running");
  const active = getInlineWorkingIndicatorActive({
    isStreaming,
    isStreamingResponseText,
    isToolActive,
    hasRunningTask,
  });
  // Initial thinking is pre-tool only. Once a tool lifecycle begins the
  // indicator follows live TOOL_START/TOOL_END state instead of the
  // long-lived root run, so spawn_agent/send_input do not pin it while the
  // agent works.
  const isPreToolThinking =
    isStreaming && !isStreamingResponseText && !hasToolActivity;
  return {
    active,
    // Once the assistant starts streaming answer text, get out of the way
    // immediately instead of trailing the growing message for the
    // min-visible hold. Other deactivations (run finished, sub-agent took
    // over) keep the hold so a fast turn still flashes the indicator.
    exitImmediately: isStreamingResponseText,
    runningTool: isToolActive ? (activeToolName ?? undefined) : undefined,
    runningToolId: isToolActive ? (activeToolCallId ?? undefined) : undefined,
    status:
      isPreToolThinking || isToolActive ? (runtimeStatusText ?? null) : null,
  };
}

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
