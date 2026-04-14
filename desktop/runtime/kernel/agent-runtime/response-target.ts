import type { RuntimeAgentEventPayload } from "../../protocol/index.js";

const TASK_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskPause",
  "TaskOutput",
]);

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const asTaskId = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const getTaskIdFromArgsLike = (value: unknown): string | undefined => {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return (
    asTaskId(record.thread_id) ??
    asTaskId(record.threadId) ??
    asTaskId(record.id)
  );
};

const getTaskIdFromToolDetails = (
  toolName: string,
  details: unknown,
): string | undefined => {
  if (toolName === "TaskCreate") {
    const record = asRecord(details);
    if (!record) {
      return undefined;
    }
    return (
      asTaskId(record.thread_id) ??
      getTaskIdFromArgsLike(record.result) ??
      getTaskIdFromArgsLike(record.details)
    );
  }
  return getTaskIdFromArgsLike(details);
};

const isExplicitTaskResponseTarget = (
  value: RuntimeAgentEventPayload["responseTarget"] | undefined,
): value is Exclude<RuntimeAgentEventPayload["responseTarget"], { type: "user_turn" } | undefined> =>
  Boolean(value && value.type !== "user_turn");

export type OrchestratorResponseTargetTracker = {
  noteToolStart: (toolName: string, args: unknown) => void;
  noteToolEnd: (toolName: string, details: unknown) => void;
  resolve: () => RuntimeAgentEventPayload["responseTarget"];
};

export const createOrchestratorResponseTargetTracker = (
  initialTarget?: RuntimeAgentEventPayload["responseTarget"],
): OrchestratorResponseTargetTracker => {
  if (isExplicitTaskResponseTarget(initialTarget)) {
    return {
      noteToolStart: () => {},
      noteToolEnd: () => {},
      resolve: () => initialTarget,
    };
  }

  let taskId: string | null = null;
  let hasConflictingTaskIds = false;

  const recordTaskId = (candidate: string | undefined) => {
    if (!candidate || hasConflictingTaskIds) {
      return;
    }
    if (!taskId) {
      taskId = candidate;
      return;
    }
    if (taskId !== candidate) {
      taskId = null;
      hasConflictingTaskIds = true;
    }
  };

  return {
    noteToolStart: (toolName, args) => {
      if (!TASK_TOOL_NAMES.has(toolName) || toolName === "TaskCreate") {
        return;
      }
      recordTaskId(getTaskIdFromArgsLike(args));
    },
    noteToolEnd: (toolName, details) => {
      if (!TASK_TOOL_NAMES.has(toolName) || toolName === "TaskCreate") {
        return;
      }
      recordTaskId(getTaskIdFromToolDetails(toolName, details));
    },
    resolve: () =>
      taskId
        ? {
            type: "task_turn",
            taskId,
          }
        : { type: "user_turn" },
  };
};

export const createTaskLifecycleResponseTarget = (args: {
  taskId?: string;
  eventType: string;
}): RuntimeAgentEventPayload["responseTarget"] => {
  const taskId = asTaskId(args.taskId);
  if (!taskId) {
    return { type: "user_turn" };
  }
  if (args.eventType === "task-completed") {
    return {
      type: "task_terminal_notice",
      taskId,
      terminalState: "completed",
    };
  }
  return {
    type: "task_turn",
    taskId,
  };
};
