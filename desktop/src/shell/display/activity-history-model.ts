import {
  getActivityRowCompletedAtMs,
  getActivityRowSearchText,
  getActivityRowStatus,
  groupActivityTasks,
  type ActivityRow,
  type TaskGroup,
  type TaskHierarchy,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";

export type CompletedActivityListItem =
  | { kind: "done"; task: TaskItem; depth: number }
  | { kind: "doneGroup"; group: TaskGroup; depth: number }
  | { kind: "doneHierarchy"; hierarchy: TaskHierarchy; depth: number };

const appendCompletedRow = (
  row: ActivityRow,
  depth: number,
  items: CompletedActivityListItem[],
): void => {
  if (row.kind === "task") {
    items.push({ kind: "done", task: row.task, depth });
    return;
  }
  if (row.kind === "group") {
    items.push({ kind: "doneGroup", group: row.group, depth });
    for (const member of row.group.members) {
      items.push({ kind: "done", task: member, depth: depth + 1 });
    }
    return;
  }
  items.push({ kind: "doneHierarchy", hierarchy: row.hierarchy, depth });
  for (const child of row.hierarchy.children) {
    appendCompletedRow(child, depth + 1, items);
  }
};

/**
 * Build the Completed dialog from the full ownership projection, then select
 * terminal roots. Filtering tasks before nesting would orphan a completed
 * child whose Manager is still running and make it reappear as a top-level
 * history row.
 */
export function buildCompletedActivityList(
  tasks: ReadonlyArray<TaskItem>,
  needle = "",
): CompletedActivityListItem[] {
  const normalizedNeedle = needle.trim().toLowerCase();
  const roots = groupActivityTasks(tasks)
    .filter((row) => getActivityRowStatus(row) !== "running")
    .filter(
      (row) =>
        !normalizedNeedle ||
        getActivityRowSearchText(row).toLowerCase().includes(normalizedNeedle),
    )
    .sort(
      (a, b) => getActivityRowCompletedAtMs(b) - getActivityRowCompletedAtMs(a),
    );

  const items: CompletedActivityListItem[] = [];
  for (const row of roots) appendCompletedRow(row, 0, items);
  return items;
}
