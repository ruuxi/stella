/**
 * Rolling per-agent progress summaries.
 *
 * A small LLM (`stella/light`) narrates what each active sub-agent is doing in
 * 3-7 word phrases (see `use-agent-progress-summaries`). Those phrases land
 * here, keyed by agentId, so the activity list can render a short scrollable
 * history under each running agent regardless of which surface is mounted.
 *
 * Plain module store + `useSyncExternalStore`, mirroring the other workspace
 * singletons (`display-search-store`, `section-collapse-store`). Arrays are
 * replaced immutably and reused by reference when unchanged so the
 * per-agent selector stays snapshot-stable.
 */

import { useSyncExternalStore } from "react";

export type ProgressSummary = {
  id: string;
  text: string;
  atMs: number;
};

/** Most recent summaries kept per agent; older ones scroll out / drop. */
export const MAX_SUMMARIES_PER_AGENT = 5;

/**
 * Memory bound now that summaries persist after an agent completes (they
 * used to be wiped via `retainOnly` the moment the agent left the running
 * set — which blanked the completed row's reasoning history in the sidebar).
 * The map keeps LRU order (an agent's entry is re-appended on every new
 * phrase); when a NEW agent would exceed the cap, the least-recently-updated
 * agent's summaries are evicted. ~50 agents x ≤5 short phrases is a few KB.
 */
export const MAX_TRACKED_AGENTS = 50;

const EMPTY_SUMMARIES: ReadonlyArray<ProgressSummary> = Object.freeze([]);

const summariesByAgent = new Map<string, ProgressSummary[]>();
const collapsedAgents = new Set<string>();

const listeners = new Set<() => void>();
let nextId = 0;

const emit = (): void => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const agentProgressSummaryStore = {
  subscribe,

  getSummaries(agentId: string): ReadonlyArray<ProgressSummary> {
    return summariesByAgent.get(agentId) ?? EMPTY_SUMMARIES;
  },

  /** Newest summary for an agent, or undefined — handy for change checks. */
  getLatestText(agentId: string): string | undefined {
    const list = summariesByAgent.get(agentId);
    return list && list.length > 0 ? list[list.length - 1].text : undefined;
  },

  /**
   * Plain `agentId -> [oldest…newest]` snapshot of every agent's summary
   * phrases. Used to mirror the summaries to the electron main process so the
   * desktop→mobile sync bridge can attach them to each task's
   * `reasoningSummaries`. Agents with no summaries are omitted.
   */
  snapshotTexts(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [agentId, list] of summariesByAgent) {
      if (list.length === 0) continue;
      out[agentId] = list.map((entry) => entry.text);
    }
    return out;
  },

  /**
   * Timestamped variant of `snapshotTexts` (`agentId -> [{text, atMs}…]`,
   * oldest…newest). Published alongside the plain texts so the runtime can
   * persist each phrase with the moment it was generated — Recall reports
   * these as "as of <time> the agent was doing <phrase>".
   */
  snapshotEntries(): Record<string, { text: string; atMs: number }[]> {
    const out: Record<string, { text: string; atMs: number }[]> = {};
    for (const [agentId, list] of summariesByAgent) {
      if (list.length === 0) continue;
      out[agentId] = list.map((entry) => ({
        text: entry.text,
        atMs: entry.atMs,
      }));
    }
    return out;
  },

  addSummary(agentId: string, rawText: string): void {
    const text = rawText.trim();
    if (!text) return;
    const existing = summariesByAgent.get(agentId) ?? [];
    // Skip back-to-back duplicates so a stalled agent doesn't spam the list.
    if (existing.length > 0 && existing[existing.length - 1].text === text) {
      return;
    }
    const entry: ProgressSummary = {
      id: `${agentId}:${nextId++}`,
      text,
      atMs: Date.now(),
    };
    const next = [...existing, entry];
    if (next.length > MAX_SUMMARIES_PER_AGENT) {
      next.splice(0, next.length - MAX_SUMMARIES_PER_AGENT);
    }
    // Delete-then-set keeps the Map in least-recently-updated → most-recent
    // insertion order, which is what the eviction below leans on.
    summariesByAgent.delete(agentId);
    summariesByAgent.set(agentId, next);
    while (summariesByAgent.size > MAX_TRACKED_AGENTS) {
      const oldest = summariesByAgent.keys().next().value;
      if (oldest === undefined) break;
      summariesByAgent.delete(oldest);
      collapsedAgents.delete(oldest);
    }
    emit();
  },

  isCollapsed(agentId: string): boolean {
    return collapsedAgents.has(agentId);
  },

  toggleCollapsed(agentId: string): void {
    if (collapsedAgents.has(agentId)) {
      collapsedAgents.delete(agentId);
    } else {
      collapsedAgents.add(agentId);
    }
    emit();
  },

  reset(): void {
    if (summariesByAgent.size === 0 && collapsedAgents.size === 0) return;
    summariesByAgent.clear();
    collapsedAgents.clear();
    emit();
  },
};

export const useAgentProgressSummaries = (
  agentId: string,
): ReadonlyArray<ProgressSummary> =>
  useSyncExternalStore(
    subscribe,
    () => agentProgressSummaryStore.getSummaries(agentId),
    () => agentProgressSummaryStore.getSummaries(agentId),
  );

export const useAgentProgressSummariesCollapsed = (agentId: string): boolean =>
  useSyncExternalStore(
    subscribe,
    () => agentProgressSummaryStore.isCollapsed(agentId),
    () => agentProgressSummaryStore.isCollapsed(agentId),
  );
