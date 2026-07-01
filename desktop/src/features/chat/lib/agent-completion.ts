/**
 * Per-agent completion card derivation.
 *
 * A delegated agent's produced files ride a single `agent-completed` event
 * (which carries `agentId`, `result`, `fileChanges[]`, `producedFiles[]`).
 * Rather than rolling those files up into the orchestrator's inline artifact
 * card (the jumpy "pop"), we surface them as clickable pills on a quiet
 * completion card anchored to the assistant row the `agent-completed` event
 * attaches to — i.e. the chronological completion point in the transcript.
 *
 * Two structural facts make this clean and append-only by construction:
 *   1. Each `agent-completed` event carries ONLY that run's files (the runner
 *      builds a fresh file-change collector per `runSubagentTask` and the
 *      manager overwrites `task.fileChanges` with the latest run's result), so
 *      a `send_input` re-run's completion lands on a LATER row with only the
 *      newly-produced files — never re-showing what an earlier completion
 *      already revealed.
 *   2. Each `agent-completed` event attaches to exactly one message row (see
 *      `group-events-into-messages`) — though during the SQLite/stream
 *      handoff the same underlying event can briefly be projected onto both
 *      the user-message fallback row and the assistant row; the dedup pass in
 *      `use-event-rows` collapses that duplicate (keyed by `agentId` +
 *      `completedAtMs`).
 *
 * Kept as a pure module (no React) so the derivation is unit-testable,
 * mirroring the other extracted chat derivations.
 */
import type { EventRecord } from "./event-transforms";
import {
  isAgentCompletedEvent,
  isAgentStartedEvent,
} from "./event-transforms";
import { deriveAgentFilesMap } from "@/features/workspace-display/agent-files";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";

/** One agent's completion, sectionalized on the card. Never merged with
 *  another agent — several agents completing at the same point each get their
 *  own header + own pills. */
export type AgentCompletionSection = {
  agentId: string;
  title: string;
  /** Latest `agent-completed` timestamp backing this section. Used by the
   *  handoff dedup in `use-event-rows` to tell an exact duplicate (same
   *  completion projected onto two rows → collapse) from a genuine
   *  `send_input` re-run (later completion on a later row → keep both). */
  completedAtMs: number;
  files: ConversationFileEntry[];
};

/** Identity/label metadata for an agent, lifted from its `agent-started`
 *  lifecycle event(s). Used to title the completion card (the
 *  `agent-completed` payload carries no `description`). */
export type AgentMeta = {
  description?: string;
  agentType?: string;
  groupLabel?: string;
};

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

/**
 * Fold every `agent-started` event across the loaded window into a per-agent
 * metadata map. The first non-empty value for each field wins so a later
 * `send_input` re-activation (which reuses the original description) doesn't
 * clobber a richer earlier label.
 */
export function buildAgentMetaMap(
  events: ReadonlyArray<EventRecord>,
): Map<string, AgentMeta> {
  const byId = new Map<string, AgentMeta>();
  for (const event of events) {
    if (!isAgentStartedEvent(event)) continue;
    const agentId = asNonEmptyString(event.payload.agentId);
    if (!agentId) continue;
    const existing = byId.get(agentId) ?? {};
    const next: AgentMeta = { ...existing };
    if (!next.description) {
      next.description = asNonEmptyString(event.payload.description);
    }
    if (!next.agentType) {
      next.agentType = asNonEmptyString(event.payload.agentType);
    }
    if (!next.groupLabel) {
      next.groupLabel = asNonEmptyString(event.payload.groupLabel);
    }
    byId.set(agentId, next);
  }
  return byId;
}

/**
 * Group a single row's `agent-completed` events by `agentId` and derive each
 * agent's produced files through the shared `deriveAgentFilesMap` /
 * `deriveConversationFiles` derivation (same path the sidebar Activity tray
 * uses), so the pill list dedupes by path exactly like everywhere else.
 * Restricted to `agent-completed` events — orchestrator-direct `tool_result`
 * files keep their own inline rendering and never become agent pills.
 */
export function deriveAgentCompletionFiles(
  toolEvents: ReadonlyArray<EventRecord>,
): Map<string, ConversationFileEntry[]> {
  return deriveAgentFilesMap(toolEvents, isAgentCompletedEvent);
}

/**
 * Build the sectioned completion card for a row: one section per agent that
 * produced files at this completion point, in first-completion order.
 *
 * Deliberately NO reserved-builtin denylist here (unlike the spawn
 * breadcrumb): an agent-produced FILE is a user-facing deliverable no matter
 * which agent made it, and before the completion-card consolidation these
 * files rendered inline for every agent type. Reserved builtins that run in
 * hidden conversations (fashion, dream, chronicle) never land in the visible
 * transcript anyway; ones that run in the user's conversation (e.g. the
 * schedule subagent, whose toolset is not restricted away from file-writing
 * tools) keep their files visible as pills. This also keeps behavior
 * identical whether or not the agent's `agent-started` (and thus its
 * `agentType`) aged out of the loaded event window.
 */
export function buildAgentCompletionSections(
  toolEvents: ReadonlyArray<EventRecord>,
  agentMetaById: ReadonlyMap<string, AgentMeta>,
): AgentCompletionSection[] {
  const files = deriveAgentCompletionFiles(toolEvents);
  if (files.size === 0) return [];

  // Latest completion timestamp per agent on this row (all of a section's
  // files come from that agent's `agent-completed` event(s) on this row).
  const completedAtByAgent = new Map<string, number>();
  for (const event of toolEvents) {
    if (!isAgentCompletedEvent(event)) continue;
    const agentId = asNonEmptyString(event.payload.agentId);
    if (!agentId) continue;
    const prev = completedAtByAgent.get(agentId) ?? 0;
    if (event.timestamp > prev) completedAtByAgent.set(agentId, event.timestamp);
  }

  const sections: AgentCompletionSection[] = [];
  for (const [agentId, entries] of files) {
    const meta = agentMetaById.get(agentId);
    const title =
      meta?.description?.trim() || meta?.groupLabel?.trim() || "Task";
    sections.push({
      agentId,
      title,
      completedAtMs: completedAtByAgent.get(agentId) ?? 0,
      files: [...entries],
    });
  }
  return sections;
}
