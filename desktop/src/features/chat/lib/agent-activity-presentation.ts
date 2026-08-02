import type { TaskLifecycleStatus } from "../../../../../runtime/contracts/agent-runtime.js";
import type { ThreadActivityRecord } from "../../../../../runtime/contracts/local-chat.js";

export type AgentAttemptPresentation = {
  status?: TaskLifecycleStatus;
  attemptGeneration?: number;
  rootRunId?: string;
  startedAtMs?: number;
  observedAtMs?: number;
};

export type AuthoritativeAgentPresentation = {
  status: TaskLifecycleStatus;
  attemptGeneration?: number;
  rootRunId?: string;
  updatedAtMs: number;
  completedAtMs?: number;
};

const isTerminal = (status: TaskLifecycleStatus): boolean =>
  status !== "running";

/**
 * Resolve the one status summary surfaces should present for a thread.
 *
 * The durable Activity row normally wins. A newly observed attempt is the
 * narrow exception: its start can reach the renderer before the row refetch
 * that re-opens a previously completed thread. Attempt generation is the
 * primary authority; timestamps/root-run identity are only compatibility
 * fallbacks for older lifecycle packets.
 */
export const latestAttemptSupersedesAuthoritative = (
  authoritative: AuthoritativeAgentPresentation,
  latestAttempt?: AgentAttemptPresentation,
): boolean => {
  if (!latestAttempt) return false;
  const observedStatus = latestAttempt.status ?? "running";
  const authoritativeAttempt = authoritative.attemptGeneration;
  const observedAttempt = latestAttempt.attemptGeneration;

  if (authoritativeAttempt !== undefined && observedAttempt !== undefined) {
    if (observedAttempt > authoritativeAttempt) return true;
    if (observedAttempt < authoritativeAttempt) return false;

    // Same attempt: a terminal observation advances a still-running durable
    // row, while a terminal durable row fences a leftover running decoration.
    if (authoritative.status === "running" && isTerminal(observedStatus)) {
      return true;
    }
    if (isTerminal(authoritative.status) && observedStatus === "running") {
      return false;
    }
    return false;
  }

  if (
    authoritative.rootRunId &&
    latestAttempt.rootRunId &&
    authoritative.rootRunId === latestAttempt.rootRunId &&
    authoritativeAttempt === observedAttempt
  ) {
    if (authoritative.status === "running" && isTerminal(observedStatus)) {
      return true;
    }
    return false;
  }

  const observedAt =
    latestAttempt.startedAtMs ?? latestAttempt.observedAtMs ?? 0;
  const authoritativeAt =
    authoritative.completedAtMs ?? authoritative.updatedAtMs;
  return observedAt > authoritativeAt;
};

export const deriveLatestAgentPresentationStatus = (
  authoritative: AuthoritativeAgentPresentation,
  latestAttempt?: AgentAttemptPresentation,
): TaskLifecycleStatus => {
  if (!latestAttempt) return authoritative.status;
  return latestAttemptSupersedesAuthoritative(authoritative, latestAttempt)
    ? (latestAttempt.status ?? "running")
    : authoritative.status;
};

/**
 * A terminal owner is only visually complete once its currently-owned work
 * has settled. Running owners stay running; paused/failed owners keep their
 * explicit terminal state even if a stale child row still says running.
 */
export const deriveOwnedAgentPresentationStatus = (
  ownerStatus: TaskLifecycleStatus,
  ownedStatuses: readonly TaskLifecycleStatus[],
): TaskLifecycleStatus => {
  if (ownerStatus === "running") return "running";
  if (ownerStatus === "error" || ownerStatus === "canceled") {
    return ownerStatus;
  }
  if (ownedStatuses.includes("running")) return "running";
  if (ownedStatuses.includes("error")) return "error";
  return "completed";
};

const isRecordCurrentForCard = (
  record: ThreadActivityRecord,
  options: {
    attemptGeneration?: number;
    rootRunId?: string;
    startedAtMs?: number;
  },
): boolean => {
  if (
    options.attemptGeneration !== undefined &&
    record.attemptGeneration !== undefined
  ) {
    if (record.attemptGeneration < options.attemptGeneration) return false;
    if (
      record.attemptGeneration === options.attemptGeneration &&
      options.rootRunId &&
      record.rootRunId &&
      record.rootRunId !== options.rootRunId
    ) {
      return false;
    }
    return true;
  }
  if (options.rootRunId && record.rootRunId === options.rootRunId) return true;
  const cardStartedAt = options.startedAtMs ?? 0;
  return record.startedAt >= cardStartedAt || record.updatedAt >= cardStartedAt;
};

/**
 * Resolve the current durable status of one thread plus everything it owns.
 * Ownership is transitive and comes from the same authoritative Activity
 * rows used by the sidebar. Cycles fail closed on the owner's own status.
 */
export const deriveThreadAndOwnedPresentationStatus = (
  records: readonly ThreadActivityRecord[],
  threadId: string,
  options: {
    attemptGeneration?: number;
    rootRunId?: string;
    startedAtMs?: number;
  } = {},
): TaskLifecycleStatus | undefined => {
  const recordById = new Map(records.map((record) => [record.threadId, record]));
  const childrenByParent = new Map<string, ThreadActivityRecord[]>();
  for (const record of records) {
    // Claude Code owns the lifecycle of its native children. Those rows are
    // passive observations for Activity/chat and must not hold a Stella-owned
    // parent card open or change its completion/failure state.
    if (record.source === "claude-native") continue;
    if (!record.parentAgentId || record.parentAgentId === record.threadId) {
      continue;
    }
    const children = childrenByParent.get(record.parentAgentId);
    if (children) children.push(record);
    else childrenByParent.set(record.parentAgentId, [record]);
  }

  const derive = (
    id: string,
    ancestors: ReadonlySet<string>,
  ): TaskLifecycleStatus | undefined => {
    const record = recordById.get(id);
    if (!record || ancestors.has(id)) return undefined;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(id);
    const childStatuses = (childrenByParent.get(id) ?? [])
      .map((child) => derive(child.threadId, nextAncestors))
      .filter((status): status is TaskLifecycleStatus => status !== undefined);
    return deriveOwnedAgentPresentationStatus(record.status, childStatuses);
  };

  const owner = recordById.get(threadId);
  if (!owner || !isRecordCurrentForCard(owner, options)) return undefined;
  return derive(threadId, new Set());
};

/** Group/card state uses active-first precedence so a mixed card can never
 * pair a terminal glyph with its active `Working…` fallback. */
export const deriveAgentCardPresentationStatus = (input: {
  working: boolean;
  paused: boolean;
  failed: boolean;
}): TaskLifecycleStatus => {
  if (input.working) return "running";
  if (input.failed) return "error";
  if (input.paused) return "canceled";
  return "completed";
};

export const agentPresentationFallback = (
  status: TaskLifecycleStatus,
): "Working…" | "Paused" | "Failed" | "Completed" => {
  switch (status) {
    case "running":
      return "Working…";
    case "canceled":
      return "Paused";
    case "error":
      return "Failed";
    case "completed":
      return "Completed";
  }
};
