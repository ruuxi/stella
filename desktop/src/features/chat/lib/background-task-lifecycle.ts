import type { EventRecord } from "./event-transforms";
import {
  fallbackTaskDescription,
  isAgentCanceledEvent,
  isAgentCompletedEvent,
  isAgentFailedEvent,
  isAgentProgressEvent,
  isAgentStartedEvent,
} from "./event-transforms";
import {
  buildAgentCompletionSections,
  type AgentCompletionSection,
} from "./agent-completion";
import type { TaskToolActivity } from "../../../../../runtime/contracts/agent-runtime.js";

export type BackgroundTaskCardStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

/**
 * Canonical state for one visible background-work occurrence. Identity is the
 * persisted `agent-started` event id, not the durable thread id: `send_input`
 * reuses a thread and can even start it more than once inside one root run.
 */
export type BackgroundTaskCardState = {
  cardId: string;
  startEventId: string;
  agentId: string;
  rootRunId?: string;
  startedAtMs: number;
  title: string;
  agentType?: string;
  groupKey?: string;
  groupLabel?: string;
  isFollowUp: boolean;
  status: BackgroundTaskCardStatus;
  latestEventId: string;
  latestEventAtMs: number;
  progressText?: string;
  toolActivity?: TaskToolActivity;
  errorText?: string;
  terminalEventId?: string;
  completion?: AgentCompletionSection;
};

export type BackgroundTaskLifecycleIndex = {
  byStartEventId: ReadonlyMap<string, BackgroundTaskCardState>;
  startEventIdByLifecycleEventId: ReadonlyMap<string, string>;
};

export type ResolvedBackgroundTaskCardLifecycle = {
  completedThreadIds: string[];
  pausedThreadIds: string[];
  failedThreadIds: string[];
  progressTexts: Record<string, string>;
  toolActivities: Record<string, TaskToolActivity>;
  terminalEventIdsByThread: Record<string, string>;
  completionSections: AgentCompletionSection[];
};

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const correlationKey = (agentId: string, rootRunId?: string): string =>
  `${agentId}\u001f${rootRunId ?? "legacy"}`;

const eventOrder = (a: EventRecord, b: EventRecord): number =>
  a.timestamp - b.timestamp || a._id.localeCompare(b._id);

const cardTitle = (
  event: EventRecord & {
    payload: {
      agentId: string;
      description?: string;
      statusText?: string;
      groupLabel?: string;
      isFollowUp?: boolean;
    };
  },
): string => {
  const agentId = asNonEmptyString(event.payload.agentId) ?? "task";
  const followUpTitle = event.payload.isFollowUp
    ? asNonEmptyString(event.payload.statusText)
    : undefined;
  return (
    followUpTitle ??
    asNonEmptyString(event.payload.description) ??
    asNonEmptyString(event.payload.groupLabel) ??
    fallbackTaskDescription(agentId)
  );
};

const completionFor = (
  event: EventRecord,
  state: BackgroundTaskCardState,
): AgentCompletionSection | undefined => {
  const sections = buildAgentCompletionSections(
    [event],
    new Map([
      [
        state.agentId,
        {
          description: state.title,
          agentType: state.agentType,
          groupLabel: state.groupLabel,
        },
      ],
    ]),
  );
  const section = sections[0];
  if (!section) return undefined;
  return {
    ...section,
    startEventId: state.startEventId,
    completionEventId: event._id,
    ...(state.rootRunId ? { rootRunId: state.rootRunId } : {}),
  };
};

/**
 * Fold lifecycle events into spawn-anchored card state.
 *
 * Raw events are deduplicated by id before the fold because the live/SQLite
 * handoff can briefly project one event onto two messages. Terminal events
 * resolve to the latest `agent-started` in their `(agentId, rootRunId)`
 * stream. The start event remains the card's identity and insertion anchor;
 * completion time never becomes a second timeline anchor.
 */
export const buildBackgroundTaskLifecycleIndex = (
  events: ReadonlyArray<EventRecord>,
): BackgroundTaskLifecycleIndex => {
  const unique = new Map<string, EventRecord>();
  for (const event of events) unique.set(event._id, event);
  const ordered = [...unique.values()].sort(eventOrder);

  const mutableByStart = new Map<string, BackgroundTaskCardState>();
  const latestStartByCorrelation = new Map<string, string>();
  const latestLegacyStartByAgent = new Map<string, string>();
  const pendingProgressByCorrelation = new Map<string, string>();
  const startByLifecycleEvent = new Map<string, string>();

  const resolveStart = (
    agentId: string,
    rootRunId?: string,
  ): string | undefined =>
    rootRunId
      ? latestStartByCorrelation.get(correlationKey(agentId, rootRunId))
      : latestLegacyStartByAgent.get(agentId);

  for (const event of ordered) {
    if (isAgentStartedEvent(event)) {
      const agentId = asNonEmptyString(event.payload.agentId);
      if (!agentId) continue;
      const rootRunId = asNonEmptyString(event.payload.rootRunId);
      const key = correlationKey(agentId, rootRunId);
      const pending = pendingProgressByCorrelation.get(key);
      const state: BackgroundTaskCardState = {
        cardId: `agent-start:${event._id}`,
        startEventId: event._id,
        agentId,
        ...(rootRunId ? { rootRunId } : {}),
        startedAtMs: event.timestamp,
        title: cardTitle(event),
        ...(asNonEmptyString(event.payload.agentType)
          ? { agentType: asNonEmptyString(event.payload.agentType) }
          : {}),
        ...(asNonEmptyString(event.payload.groupKey)
          ? { groupKey: asNonEmptyString(event.payload.groupKey) }
          : {}),
        ...(asNonEmptyString(event.payload.groupLabel)
          ? { groupLabel: asNonEmptyString(event.payload.groupLabel) }
          : {}),
        isFollowUp: event.payload.isFollowUp === true,
        status: "running",
        latestEventId: event._id,
        latestEventAtMs: event.timestamp,
        ...(pending ? { progressText: pending } : {}),
      };
      mutableByStart.set(event._id, state);
      latestStartByCorrelation.set(key, event._id);
      if (!rootRunId) latestLegacyStartByAgent.set(agentId, event._id);
      startByLifecycleEvent.set(event._id, event._id);
      pendingProgressByCorrelation.delete(key);
      continue;
    }

    const payload = event.payload as
      | {
          agentId?: unknown;
          rootRunId?: unknown;
          statusText?: unknown;
          toolActivity?: TaskToolActivity;
        }
      | undefined;
    const agentId = asNonEmptyString(payload?.agentId);
    if (!agentId) continue;
    const rootRunId = asNonEmptyString(payload?.rootRunId);
    const key = correlationKey(agentId, rootRunId);

    if (isAgentProgressEvent(event)) {
      const text = asNonEmptyString(event.payload.statusText);
      const startEventId = resolveStart(agentId, rootRunId);
      const state = startEventId ? mutableByStart.get(startEventId) : undefined;
      if (!state) {
        if (text) {
          pendingProgressByCorrelation.set(key, text);
        }
        continue;
      }
      startByLifecycleEvent.set(event._id, state.startEventId);
      // A late progress packet must never revive a settled card.
      if (state.status !== "running") continue;
      state.latestEventId = event._id;
      state.latestEventAtMs = event.timestamp;
      if (text) state.progressText = text;
      if (event.payload.toolActivity) {
        state.toolActivity = event.payload.toolActivity;
      } else {
        delete state.toolActivity;
      }
      continue;
    }

    const terminalKind = isAgentCompletedEvent(event)
      ? "completed"
      : isAgentFailedEvent(event)
        ? "failed"
        : isAgentCanceledEvent(event)
          ? "canceled"
          : null;
    if (!terminalKind) continue;
    const startEventId = resolveStart(agentId, rootRunId);
    const state = startEventId ? mutableByStart.get(startEventId) : undefined;
    if (!state || event.timestamp < state.startedAtMs) continue;
    startByLifecycleEvent.set(event._id, state.startEventId);
    state.latestEventId = event._id;
    state.latestEventAtMs = event.timestamp;
    state.terminalEventId = event._id;
    if (terminalKind === "completed") {
      state.status = "completed";
      state.completion = completionFor(event, state);
      delete state.errorText;
    } else if (terminalKind === "failed") {
      state.status = "failed";
      state.errorText = asNonEmptyString(
        (event.payload as { error?: unknown } | undefined)?.error,
      );
      delete state.completion;
    } else {
      state.status = "canceled";
      state.errorText = asNonEmptyString(
        (event.payload as { error?: unknown } | undefined)?.error,
      );
      delete state.completion;
    }
  }

  return {
    byStartEventId: mutableByStart,
    startEventIdByLifecycleEventId: startByLifecycleEvent,
  };
};

/** Project canonical lifecycle state onto one spawn/group card descriptor. */
export const resolveBackgroundTaskCardLifecycle = (
  threadIds: readonly string[],
  startEventIdsByThread: Readonly<Record<string, string>>,
  index: BackgroundTaskLifecycleIndex,
): ResolvedBackgroundTaskCardLifecycle => {
  const resolved: ResolvedBackgroundTaskCardLifecycle = {
    completedThreadIds: [],
    pausedThreadIds: [],
    failedThreadIds: [],
    progressTexts: {},
    toolActivities: {},
    terminalEventIdsByThread: {},
    completionSections: [],
  };
  for (const threadId of threadIds) {
    const startEventId = startEventIdsByThread[threadId];
    const state = startEventId
      ? index.byStartEventId.get(startEventId)
      : undefined;
    if (!state) continue;
    if (state.progressText)
      resolved.progressTexts[threadId] = state.progressText;
    if (state.toolActivity)
      resolved.toolActivities[threadId] = state.toolActivity;
    if (state.terminalEventId) {
      resolved.terminalEventIdsByThread[threadId] = state.terminalEventId;
    }
    if (state.status === "completed") {
      resolved.completedThreadIds.push(threadId);
      if (state.completion) resolved.completionSections.push(state.completion);
    } else if (state.status === "canceled") {
      resolved.pausedThreadIds.push(threadId);
    } else if (state.status === "failed") {
      resolved.failedThreadIds.push(threadId);
    }
  }
  return resolved;
};
