import type { TaskLifecycleStatus } from "../../../../../runtime/contracts/agent-runtime.js";

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
