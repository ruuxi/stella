import {
  AGENT_STREAM_EVENT_TYPES,
  isTaskLifecycleEventType,
  isTerminalTaskLifecycleStatus,
  shouldIgnoreTerminalTaskFeedEvent,
  type TaskLifecycleStatus,
} from "../../../runtime/contracts/agent-runtime.js";

export const MAX_AGENT_REASONING_CHARS = 8_000;

export type ConversationTaskSnapshot = {
  runId: string;
  agentId: string;
  agentType?: string;
  description?: string;
  anchorTurnId?: string;
  parentAgentId?: string;
  status: TaskLifecycleStatus;
  statusText?: string;
  reasoningText?: string;
  result?: string;
  error?: string;
  groupKey?: string;
  groupLabel?: string;
  // Real lifecycle timestamps, stamped here at event receipt. startedAtMs is
  // first-seen-only and completedAtMs is sticky once terminal, so a resume
  // snapshot re-emitted to a rehydrating renderer never carries a "fresh"
  // timestamp that would out-rank the task's actual completion and reorder
  // settled activity rows.
  startedAtMs: number;
  completedAtMs?: number;
};

// The subset of an agent stream event the snapshot reducer reads. Kept
// structural so the reducer can be exercised without a full IPC payload.
export type TaskSnapshotSourceEvent = {
  type: string;
  agentType?: string;
  description?: string;
  userMessageId?: string;
  parentAgentId?: string;
  statusText?: string;
  chunk?: string;
  result?: string;
  error?: string;
  groupKey?: string;
  groupLabel?: string;
};

/**
 * Pure reducer for the main-process task snapshot map. Given the current
 * snapshot for a task id and an incoming lifecycle/reasoning event, returns
 * the next snapshot, or `null` when the event should be ignored (a stale
 * terminal-state feed event). Timestamps are injected via `nowMs` so callers
 * stay deterministic and tests need no clock stubbing.
 */
export const reduceTaskSnapshot = (args: {
  current: ConversationTaskSnapshot | undefined;
  event: TaskSnapshotSourceEvent;
  runId: string;
  agentId: string;
  nowMs: number;
}): ConversationTaskSnapshot | null => {
  const { current, event, runId, agentId, nowMs } = args;

  const isReasoning = event.type === AGENT_STREAM_EVENT_TYPES.AGENT_REASONING;
  if (!isReasoning && !isTaskLifecycleEventType(event.type)) return null;

  const base: ConversationTaskSnapshot = {
    runId,
    agentId,
    agentType: event.agentType ?? current?.agentType,
    description: event.description ?? current?.description,
    anchorTurnId: event.userMessageId ?? current?.anchorTurnId,
    parentAgentId: event.parentAgentId ?? current?.parentAgentId,
    status: current?.status ?? "running",
    statusText: current?.statusText,
    reasoningText: current?.reasoningText,
    result: current?.result,
    error: current?.error,
    groupKey: event.groupKey ?? current?.groupKey,
    groupLabel: event.groupLabel ?? current?.groupLabel,
    startedAtMs: current?.startedAtMs ?? nowMs,
    completedAtMs: current?.completedAtMs,
  };

  if (
    shouldIgnoreTerminalTaskFeedEvent({
      currentStatus: current?.status,
      eventType: event.type as Parameters<
        typeof shouldIgnoreTerminalTaskFeedEvent
      >[0]["eventType"],
    })
  ) {
    return null;
  }

  switch (event.type) {
    case AGENT_STREAM_EVENT_TYPES.AGENT_STARTED:
      base.status = "running";
      base.statusText = event.statusText ?? current?.statusText;
      base.reasoningText = "";
      base.result = undefined;
      base.error = undefined;
      // A genuine revive: AGENT_STARTED arriving after the task already
      // reached a terminal state means a brand-new run of the same task id.
      // Clear the prior run's completion time so the now-running task no
      // longer carries a stale completedAtMs. Ordinary re-upserts / hydration
      // re-emits leave a settled completedAtMs untouched because they never
      // transition through a terminal-then-started sequence.
      if (isTerminalTaskLifecycleStatus(current?.status)) {
        base.completedAtMs = undefined;
      }
      break;
    case AGENT_STREAM_EVENT_TYPES.AGENT_REASONING: {
      base.status = "running";
      base.result = undefined;
      base.error = undefined;
      const merged = `${current?.reasoningText ?? ""}${event.chunk ?? ""}`;
      base.reasoningText =
        merged.length > MAX_AGENT_REASONING_CHARS
          ? merged.slice(-MAX_AGENT_REASONING_CHARS)
          : merged;
      break;
    }
    case AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS:
      base.status = "running";
      base.statusText = event.statusText ?? current?.statusText;
      base.result = undefined;
      base.error = undefined;
      break;
    case AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED:
      base.status = "completed";
      base.statusText = undefined;
      base.result = event.result;
      base.error = undefined;
      base.completedAtMs = current?.completedAtMs ?? nowMs;
      break;
    case AGENT_STREAM_EVENT_TYPES.AGENT_FAILED:
      base.status = "error";
      base.statusText = undefined;
      base.result = undefined;
      base.error = event.error;
      base.completedAtMs = current?.completedAtMs ?? nowMs;
      break;
    case AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED:
      base.status = "canceled";
      base.statusText = undefined;
      base.result = undefined;
      base.error = event.error;
      base.completedAtMs = current?.completedAtMs ?? nowMs;
      break;
  }

  return base;
};
