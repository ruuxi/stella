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
   * Escape hatch to skip the `MIN_VISIBLE_MS` floor on deactivation.
   * No longer set by `buildInlineWorkingIndicatorProps`: because `active`
   * now stays true until the first character is painted, the floor is
   * purely anti-flicker and must never cause an early dismiss. Kept
   * optional for the component's own fallback handling.
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
}: {
  isStreaming: boolean;
  /**
   * True once the assistant's first character is actually *painted* on
   * screen for the in-flight run (driven by the `StreamingTextReveal`
   * reveal frontier via `mark-streaming-text`), not merely once the first
   * delta arrived in the data stream. This is the indicator's hand-off
   * trigger, so the indicator never disappears into a gap before any text
   * is visible.
   */
  isStreamingResponseText: boolean;
  isToolActive: boolean;
  hasToolActivity: boolean;
  activeToolName?: string | null;
  activeToolCallId?: string | null;
  runtimeStatusText?: string | null;
}): InlineWorkingIndicatorMountProps {
  const active = getInlineWorkingIndicatorActive({
    isStreaming,
    isStreamingResponseText,
    isToolActive,
  });
  // Initial thinking is pre-tool only. Once a tool lifecycle begins the
  // indicator follows live TOOL_START/TOOL_END state instead of the
  // long-lived root run, so spawn_agent/send_input do not pin it while the
  // agent works.
  const isPreToolThinking =
    isStreaming && !isStreamingResponseText && !hasToolActivity;
  return {
    active,
    // No early dismiss: deactivation always runs through the min-visible
    // floor (`getInlineWorkingIndicatorExitDelayMs`). Because `active` now
    // stays true until the first character is painted, the floor only ever
    // *delays* a too-fast hide (anti-flicker) — it never causes one. The
    // effective hide time is max(min-duration elapsed, first-painted-text).
    runningTool: isToolActive ? (activeToolName ?? undefined) : undefined,
    runningToolId: isToolActive ? (activeToolCallId ?? undefined) : undefined,
    status:
      isPreToolThinking || isToolActive ? (runtimeStatusText ?? null) : null,
  };
}

/**
 * On run resume/reactivation the assistant's already-streamed answer is
 * rehydrated from persistence (a real `assistant_message` row) with no
 * live overlay, so `StreamingTextReveal` never mounts and never fires the
 * first-paint hand-off (`notifyAssistantTextPainted` → `mark-streaming-
 * text`). Because the resume snapshot seeds the active run with
 * `isStreamingText: false`, the inline working indicator would otherwise
 * hang "Thinking" *under* the fully-visible resumed answer until the run
 * finally goes terminal.
 *
 * Detect exactly that shape — the run is still active, the indicator has
 * not handed off yet, there is no live streaming overlay (a live turn
 * always has at least a placeholder overlay), and the active turn's answer
 * is already on screen — so the caller can treat the resumed text as
 * painted. It is a no-op for live streaming, where `hasLiveStreamingOverlay`
 * is true (or `isStreamingResponseText` already flipped via the reveal).
 */
export function shouldTreatResumedAnswerAsPainted({
  isStreaming,
  isStreamingResponseText,
  hasLiveStreamingOverlay,
  activeTurnAnswerVisible,
}: {
  isStreaming: boolean;
  isStreamingResponseText: boolean;
  hasLiveStreamingOverlay: boolean;
  activeTurnAnswerVisible: boolean;
}): boolean {
  if (!isStreaming) return false;
  if (isStreamingResponseText) return false;
  if (hasLiveStreamingOverlay) return false;
  return activeTurnAnswerVisible;
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
}: {
  isStreaming: boolean;
  /**
   * True once the assistant's first character is actually painted (reveal
   * frontier), the hand-off point. Until then the indicator stays up no
   * matter how long the model thinks.
   */
  isStreamingResponseText: boolean;
  isToolActive: boolean;
}): boolean {
  if (isToolActive) return true;
  // Stay visible continuously from send through the whole turn — pre-tool
  // thinking, gaps between tools, and while a spawned agent works — until
  // the assistant's first character is actually painted. A background or
  // spawned agent no longer suppresses the orchestrator's own indicator.
  return isStreaming && !isStreamingResponseText;
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
