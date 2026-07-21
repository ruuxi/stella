import type { TaskItem } from "@/features/chat/lib/event-transforms";
import { TextShimmer } from "@/app/chat/TextShimmer";

export const LEFT_SIDEBAR_ACTIVITY_SHIMMER_GROUP = "left-sidebar-activity";

export const isTopLevelActivityShimmerEligible = (
  task: Pick<TaskItem, "status">,
  isTopLevel: boolean,
): boolean => isTopLevel && task.status === "running";

/** One bounded shimmer owner for visible, running top-level Activity rows. */
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
      exclusiveGroup={LEFT_SIDEBAR_ACTIVITY_SHIMMER_GROUP}
    />
  );
}
