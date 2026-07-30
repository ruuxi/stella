import { useRef } from "react";
import type { TaskItem } from "@/features/chat/lib/event-transforms";
import type { AgentModelConfigSnapshot } from "../../../../../runtime/contracts/agent-engine.js";

export type AgentModelConfigsByThread = Readonly<
  Record<string, AgentModelConfigSnapshot | undefined>
>;

const signatureForTasks = (tasks: readonly TaskItem[]): string =>
  tasks
    .map(
      (task) =>
        `${task.id}\u0000${JSON.stringify(task.modelConfigSnapshot ?? null)}`,
    )
    .join("\n");

/**
 * Keep the thread-to-model map stable across status/progress-only task
 * updates. Chat rows only need to repaint when a thread's resolved model
 * metadata actually changes.
 */
export const useAgentModelConfigs = (
  tasks: readonly TaskItem[],
): AgentModelConfigsByThread => {
  const signature = signatureForTasks(tasks);
  const cached = useRef<{
    signature: string;
    value: AgentModelConfigsByThread;
  }>({ signature: "", value: {} });

  if (cached.current.signature !== signature) {
    cached.current = {
      signature,
      value: Object.fromEntries(
        tasks.map((task) => [task.id, task.modelConfigSnapshot]),
      ),
    };
  }
  return cached.current.value;
};
