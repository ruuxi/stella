/**
 * Live task state for the inline "background work" cards.
 *
 * The card's *presence* (and which work threads it covers) is derived
 * statically from the spawning turn's tool events in `useEventRows`, so it
 * persists across reload and stays identity-stable for virtualization.
 * Its *live* status — running narration, failures, cancellations — comes
 * from this context instead, so a progress tick re-renders only the cards
 * (which read the map) rather than re-projecting every chat row.
 *
 * Each chat surface feeds the already-merged task list it has on hand
 * (full chat: persisted activity + live tasks; compact surfaces: live
 * tasks). Threads with no entry here fall back to the reload-safe
 * "completed" signal carried on the row, then to a pending/in-progress
 * assumption — so a freshly-spawned thread reads as in-progress without
 * waiting on the first lifecycle event.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TaskItem } from "@/features/chat/lib/event-transforms";

const EMPTY_TASKS: ReadonlyMap<string, TaskItem> = new Map();

const BackgroundWorkContext =
  createContext<ReadonlyMap<string, TaskItem>>(EMPTY_TASKS);

export function BackgroundWorkProvider({
  tasks,
  children,
}: {
  tasks?: TaskItem[];
  children: ReactNode;
}) {
  const map = useMemo(() => {
    if (!tasks || tasks.length === 0) return EMPTY_TASKS;
    const next = new Map<string, TaskItem>();
    for (const task of tasks) next.set(task.id, task);
    return next;
  }, [tasks]);

  return (
    <BackgroundWorkContext.Provider value={map}>
      {children}
    </BackgroundWorkContext.Provider>
  );
}

export function useBackgroundWorkTasks(): ReadonlyMap<string, TaskItem> {
  return useContext(BackgroundWorkContext);
}
