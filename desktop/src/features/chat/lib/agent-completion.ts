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
 *      `group-events-into-messages`), so a completion card built from a row's
 *      own events never competes with another row for the same completion.
 *
 * Kept as a pure module (no React) so the derivation is unit-testable,
 * mirroring the other extracted chat derivations.
 */
import type { EventRecord } from "./event-transforms";
import {
  isAgentCompletedEvent,
  isAgentStartedEvent,
} from "./event-transforms";
import { isOrchestratorReservedBuiltinAgentId } from "../../../../../runtime/contracts/agent-runtime.js";
import {
  deriveConversationFiles,
  type ConversationFileEntry,
} from "@/features/workspace-display/derive-conversation-files";

/** One agent's completion, sectionalized on the card. Never merged with
 *  another agent — several agents completing at the same point each get their
 *  own header + own pills. */
export type AgentCompletionSection = {
  agentId: string;
  title: string;
  files: ConversationFileEntry[];
};

/** Identity/label metadata for an agent, lifted from its `agent-started`
 *  lifecycle event(s). Used to title the completion card and to apply the
 *  reserved-builtin denylist (the `agent-completed` payload carries neither
 *  `description` nor `agentType`). */
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
 * agent's produced files through the shared `deriveConversationFiles`
 * derivation (same path the sidebar Activity tray uses), so the pill list
 * dedupes by path exactly like everywhere else.
 *
 * Insertion order follows the first `agent-completed` event per agent, giving
 * a deterministic section order.
 */
export function deriveAgentCompletionFiles(
  toolEvents: ReadonlyArray<EventRecord>,
): Map<string, ConversationFileEntry[]> {
  const eventsByAgent = new Map<string, EventRecord[]>();
  for (const event of toolEvents) {
    if (!isAgentCompletedEvent(event)) continue;
    const agentId = asNonEmptyString(event.payload.agentId);
    if (!agentId) continue;
    const list = eventsByAgent.get(agentId);
    if (list) list.push(event);
    else eventsByAgent.set(agentId, [event]);
  }
  const filesByAgent = new Map<string, ConversationFileEntry[]>();
  for (const [agentId, events] of eventsByAgent) {
    const files = deriveConversationFiles(events);
    if (files.length > 0) filesByAgent.set(agentId, files);
  }
  return filesByAgent;
}

/**
 * Build the sectioned completion card for a row: one section per delegated
 * agent that produced files at this completion point. Orchestrator-reserved
 * builtin agents (schedule, fashion, explore, …) are filtered out via the same
 * denylist `spawn_agent` and the background-work card use — their outputs are
 * internal plumbing, not user-facing deliverables. An agent whose
 * `agent-started` aged out of the window (no meta) is kept: it produced files,
 * so it's a real delegated deliverable.
 */
export function buildAgentCompletionSections(
  toolEvents: ReadonlyArray<EventRecord>,
  agentMetaById: ReadonlyMap<string, AgentMeta>,
  filesByAgent?: ReadonlyMap<string, ConversationFileEntry[]>,
): AgentCompletionSection[] {
  const files = filesByAgent ?? deriveAgentCompletionFiles(toolEvents);
  const sections: AgentCompletionSection[] = [];
  for (const [agentId, entries] of files) {
    const meta = agentMetaById.get(agentId);
    if (meta?.agentType && isOrchestratorReservedBuiltinAgentId(meta.agentType)) {
      continue;
    }
    const title =
      meta?.description?.trim() || meta?.groupLabel?.trim() || "Task";
    sections.push({ agentId, title, files: [...entries] });
  }
  return sections;
}
