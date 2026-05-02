import type { TaskItem } from "@/app/chat/lib/event-transforms";
import { getWorkingIndicatorDisplayStatus } from "./working-indicator-state";

export const TASK_ROTATE_MS = 3000;

type StickyThinkingFooterState = {
  activeTask: TaskItem | null;
  displayTasks: TaskItem[];
  status: string | undefined;
  shouldRender: boolean;
};

export function getStickyThinkingFooterDisplayText(args: {
  state: StickyThinkingFooterState;
  runningTool?: string;
  isReasoning?: boolean;
  fallbackText?: string;
}): string | null {
  if (!args.state.shouldRender) {
    return null;
  }
  return getWorkingIndicatorDisplayStatus({
    status: args.state.status,
    toolName: args.runningTool,
    tasks: args.state.activeTask ? [args.state.activeTask] : undefined,
    isReasoning: args.isReasoning ?? !args.state.activeTask,
  }) ?? args.fallbackText ?? null;
}

export function getStickyThinkingFooterState(args: {
  tasks: TaskItem[];
  activeIndex: number;
  isStreaming?: boolean;
  status?: string | null;
}): StickyThinkingFooterState {
  const runningTasks = args.tasks.filter((task) => task.status === "running");
  const completedTasks = args.tasks.filter((task) => task.status === "completed");
  const displayTasks = runningTasks.length > 0 ? runningTasks : completedTasks;
  const activeTask =
    displayTasks.length > 0
      ? displayTasks[args.activeIndex % displayTasks.length]
      : null;

  return {
    activeTask,
    displayTasks,
    // Run-level status describes the orchestrator turn. If an agent task is
    // active, let that task own the footer copy instead of being overwritten.
    status: activeTask ? undefined : (args.status ?? undefined),
    shouldRender: Boolean(activeTask || args.isStreaming),
  };
}
