import { useMemo } from "react";
import {
  extractTasksFromActivities,
  mergeFooterTasks,
  type EventRecord,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";

/**
 * Merged background-task state for the inline background-work cards (and the
 * composer activity pill): persisted agent-lifecycle activity — the reload-
 * safe terminal status — overlaid with the live task stream (running
 * narration / failures while in flight).
 *
 * Centralizes the merge so the full chat (`ChatColumn`), the compact/mini
 * surfaces (`CompactConversationSurface`), and the pill all compute it the
 * same way instead of each hand-rolling the expression with its own deps.
 */
export function useMergedBackgroundTasks({
  activities,
  liveTasks,
  latestMessageTimestampMs = null,
}: {
  activities: EventRecord[] | undefined;
  liveTasks: TaskItem[] | undefined;
  latestMessageTimestampMs?: number | null;
}): TaskItem[] {
  return useMemo(
    () =>
      mergeFooterTasks(
        extractTasksFromActivities(activities ?? [], {
          latestMessageTimestampMs,
        }),
        liveTasks,
      ),
    [activities, liveTasks, latestMessageTimestampMs],
  );
}
