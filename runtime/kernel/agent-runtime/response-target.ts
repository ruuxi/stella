import type { RuntimeAgentEventPayload } from "../../protocol/index.js";

// Sub-agent management tool names. These all share the same task ids and
// `thread_id`-shaped payloads.
const TASK_TOOL_NAMES = new Set([
  "spawn_agent",
  "send_input",
  "pause_agent",
]);

const isSpawnAgentName = (toolName: string): boolean => toolName === "spawn_agent";

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
  if (isSpawnAgentName(toolName)) {
    const record = asRecord(details);
    if (!record) {
      return undefined;
    }
    return (
      asTaskId(record.thread_id) ??
      getTaskIdFromArgsLike(record.result) ??
      getTaskIdFromArgsLike(record.details) ??
      // Some task surfaces return the snapshot inline; fall back to the raw
      // record when that happens.
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

  let agentId: string | null = null;
  let hasConflictingTaskIds = false;

  const recordTaskId = (candidate: string | undefined) => {
    if (!candidate || hasConflictingTaskIds) {
      return;
    }
    if (!agentId) {
      agentId = candidate;
      return;
    }
    if (agentId !== candidate) {
      agentId = null;
      hasConflictingTaskIds = true;
    }
  };

  return {
    noteToolStart: (toolName, args) => {
      if (TASK_TOOL_NAMES.has(toolName) && !isSpawnAgentName(toolName)) {
        recordTaskId(getTaskIdFromArgsLike(args));
      }
    },
    noteToolEnd: (toolName, details) => {
      if (TASK_TOOL_NAMES.has(toolName)) {
        recordTaskId(getTaskIdFromToolDetails(toolName, details));
        return;
      }
      for (const id of collectTaskEventTaskIds(details)) {
        recordTaskId(id);
      }
    },
    resolve: () =>
      agentId
        ? {
            type: "agent_turn",
            agentId,
          }
        : { type: "user_turn" },
  };
};

export const createAgentLifecycleResponseTarget = (args: {
  agentId?: string;
  eventType: string;
}): RuntimeAgentEventPayload["responseTarget"] => {
  const agentId = asTaskId(args.agentId);
  if (!agentId) {
    return { type: "user_turn" };
  }
  if (args.eventType === "agent-completed") {
    return {
      type: "agent_terminal_notice",
      agentId,
      terminalState: "completed",
    };
  }
  return {
    type: "agent_turn",
    agentId,
  };
};
