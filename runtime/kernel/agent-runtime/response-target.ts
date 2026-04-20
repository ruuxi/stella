import type { RuntimeAgentEventPayload } from "../../protocol/index.js";

// Top-level legacy task tool names plus the matching `tools.*` entries the
// model now calls from inside `Exec`. Both surfaces share the same task ids
// and `thread_id`-shaped payloads.
const TASK_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskPause",
  "TaskOutput",
  "task_create",
  "task_update",
  "task_pause",
  "task_output",
]);

const isTaskCreateName = (toolName: string): boolean =>
  toolName === "TaskCreate" || toolName === "task_create";

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
  if (isTaskCreateName(toolName)) {
    const record = asRecord(details);
    if (!record) {
      return undefined;
    }
    return (
      asTaskId(record.thread_id) ??
      getTaskIdFromArgsLike(record.result) ??
      getTaskIdFromArgsLike(record.details) ??
      // task_create through Exec returns its result inline as the registry
      // value; fall back to the raw record (already a thread snapshot).
      asTaskId(record.threadId) ??
      asTaskId(record.id)
    );
  }
  return getTaskIdFromArgsLike(details);
};

const TASK_NESTED_EVENT_KEYS = ["events", "calls"] as const;

const collectTaskEventTaskIds = (details: unknown): string[] => {
  const ids: string[] = [];
  const record = asRecord(details);
  if (!record) return ids;
  for (const key of TASK_NESTED_EVENT_KEYS) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list as unknown[]) {
      const event = asRecord(entry);
      if (!event) continue;
      const toolName =
        typeof event.toolName === "string"
          ? event.toolName
          : typeof event.binding === "string" && typeof event.method === "string"
            ? `${event.binding}.${event.method}`
            : "";
      if (!TASK_TOOL_NAMES.has(toolName)) continue;
      const candidate =
        getTaskIdFromArgsLike(event.args) ??
        getTaskIdFromArgsLike(event.input) ??
        getTaskIdFromArgsLike(event.result) ??
        getTaskIdFromArgsLike(event.resultPreview);
      if (candidate) ids.push(candidate);
    }
  }
  return ids;
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
      if (TASK_TOOL_NAMES.has(toolName) && !isTaskCreateName(toolName)) {
        recordTaskId(getTaskIdFromArgsLike(args));
      }
    },
    noteToolEnd: (toolName, details) => {
      if (TASK_TOOL_NAMES.has(toolName)) {
        recordTaskId(getTaskIdFromToolDetails(toolName, details));
        return;
      }
      // Inspect Exec/Wait result envelopes for nested task tool calls so
      // continuation/follow-up flows still bind to the same task thread.
      if (toolName === "Exec" || toolName === "Wait") {
        for (const id of collectTaskEventTaskIds(details)) {
          recordTaskId(id);
        }
      }
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
