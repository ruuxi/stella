import type { TaskItem } from "@/features/chat/lib/event-transforms";
import { TextShimmer } from "@/app/chat/TextShimmer";

export const isTopLevelActivityShimmerEligible = (
  task: Pick<TaskItem, "status">,
  isTopLevel: boolean,
): boolean => isTopLevel && task.status === "running";

/** Shimmer every visible, running top-level Activity row. */
export function ActivityTaskShimmer({
  task,
  text,
  isTopLevel,
}: {
  task: Pick<TaskItem, "agentType" | "status">;
  text: string;
  isTopLevel: boolean;
}) {
  if (!isTopLevelActivityShimmerEligible(task, isTopLevel)) return text;
  return (
    <TextShimmer
      text={text}
      durationMs={2000}
      className="activity-task-shimmer"
    />
  );
}
