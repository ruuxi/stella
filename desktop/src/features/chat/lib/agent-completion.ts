/**
 * Per-agent completion card derivation.
 *
 * A delegated agent's produced files ride a single `agent-completed` event
 * (which carries `agentId`, `result`, `fileChanges[]`, `producedFiles[]`). The
 * background-task lifecycle selector folds that payload back onto the card
 * created by the matching `agent-started` occurrence, so completion enriches
 * the existing spawn-anchored card instead of inserting another timeline row.
 *
 * Two structural facts make this clean and append-only by construction:
 *   1. Each `agent-completed` event carries ONLY files not yet revealed by an
 *      earlier completion: the manager banks every run's collected records
 *      (including runs a `send_input` follow-up aborted before their rollup
 *      could fire) and drains the bank when a completion event is actually
 *      emitted. A `send_input` re-run's completion therefore lands on a LATER
 *      row with the files produced since the last emitted rollup — never
 *      re-showing what an earlier completion already revealed, and never
 *      losing what an interrupted run produced.
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
  fallbackTaskDescription,
  isAgentCompletedEvent,
  isAgentStartedEvent,
} from "./event-transforms";
import { deriveAgentFilesMap } from "@/features/workspace-display/agent-files";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";
import { isDeclaredOutputPath } from "@/features/workspace-display/path-to-viewer";

/** One agent's completion, sectionalized on the card. Never merged with
 *  another agent — several agents completing at the same point each get their
 *  own header + own pills. */
export type AgentCompletionSection = {
  agentId: string;
  agentType?: string;
  title: string;
  /** Canonical lifecycle/card diagnostics. Optional for legacy callers that
   * derive a loose section without a matching start event. */
  startEventId?: string;
  completionEventId?: string;
  rootRunId?: string;
  /** Latest `agent-completed` timestamp backing this section. Also supports
   *  deduplication for legacy loose completion attachments. */
  completedAtMs: number;
  /** May be empty: a completion without produced files still gets a card
   *  (files enrich the card; their absence never suppresses it). */
  files: ConversationFileEntry[];
  /** Compact excerpt of the agent's `result` text, from the latest
   *  `agent-completed` event backing this section. The card renders it only
   *  for fileless sections, where it stands in for the file pills as the
   *  completion's substance. Inline-only markdown, safe for the chat
   *  `Markdown` component: block constructs are stripped and truncation-
   *  dangled inline markers removed (see `toSummaryExcerpt`). */
  summary?: string;
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
 * Declared deliverables (`~/.stella/outputs/**`) lead the pill list; the pill
 * cap then truncates incidental writes (worktree scratch, intermediate
 * assets) instead of the files the user actually asked for. Stable within
 * each group, so `deriveConversationFiles`' most-recent-first order is
 * preserved among peers. Entries are already deduped by path upstream
 * (`deriveConversationFiles` keys its map by path).
 */
const rankDeliverablesFirst = (
  entries: ConversationFileEntry[],
): ConversationFileEntry[] => [
  ...entries.filter((entry) => isDeclaredOutputPath(entry.path)),
  ...entries.filter((entry) => !isDeclaredOutputPath(entry.path)),
];

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

/** Cap for the fileless-section summary excerpt (whitespace-collapsed). */
const SUMMARY_MAX_CHARS = 200;

/** How far below the cap a word boundary may sit and still be preferred. */
const SUMMARY_BOUNDARY_SLACK = 32;

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Truncate to at most `max` UTF-16 units without splitting a grapheme
 * cluster — a blind `slice` can cut a surrogate pair (emoji, rare CJK) in
 * half and render a replacement character at the excerpt's edge.
 */
const truncateAtGrapheme = (value: string, max: number): string => {
  if (value.length <= max) return value;
  if (!graphemeSegmenter) {
    // Fallback: only guard the surrogate-pair case at the cut point.
    const cut = value.slice(0, max);
    return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  }
  let end = 0;
  for (const { index, segment } of graphemeSegmenter.segment(value)) {
    if (index + segment.length > max) break;
    end = index + segment.length;
  }
  return value.slice(0, end);
};

/**
 * Reduce a markdown result to inline-only markdown before the excerpt is
 * collapsed to one line. The excerpt renders through the chat `Markdown`
 * component, but it's a muted one-liner, not a document: block constructs
 * would either render at document scale (headings) or — worse — turn into
 * stray literals once newlines collapse (`## Heading` mid-line renders as a
 * literal "##"). Strip them line-by-line while newline context still
 * exists; inline emphasis / code spans pass through untouched.
 */
const stripBlockMarkdown = (text: string): string =>
  text
    .split(/\r?\n/)
    // Drop fence delimiter lines; fenced content stays as plain text.
    .filter((line) => !/^\s*(?:```|~~~)/.test(line))
    .map((line) =>
      line
        // ATX headings (`## Title`) → plain text.
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        // Blockquote markers (possibly nested).
        .replace(/^\s*(?:>\s?)+/, "")
        // Bullet / ordered list markers.
        .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "")
        // Horizontal rules become nothing.
        .replace(/^\s*(?:[-*_]\s*){3,}$/, ""),
    )
    .join("\n");

const removeLastOccurrence = (text: string, marker: string): string => {
  const index = text.lastIndexOf(marker);
  if (index === -1) return text;
  return text.slice(0, index) + text.slice(index + marker.length);
};

const countOccurrences = (text: string, marker: string): number =>
  text.split(marker).length - 1;

/**
 * The excerpt cut can land mid-construct, leaving an unclosed `**` /
 * `` ` `` / `~~` / `*` that would style (or, for a code span, swallow) the
 * rest of the rendered excerpt. Drop the dangling opener so the truncated
 * tail renders as plain text. Approximate on purpose: pair-counting is
 * exact enough for a one-line 200-char excerpt and avoids a full inline-
 * markdown parse. Underscores are deliberately left alone — they're
 * overwhelmingly `snake_case` identifiers here, and intraword `_` never
 * triggers emphasis anyway.
 */
const dropDanglingInlineMarkers = (text: string): string => {
  let out = text;
  if (countOccurrences(out, "`") % 2 === 1) {
    out = removeLastOccurrence(out, "`");
  }
  if (countOccurrences(out, "**") % 2 === 1) {
    out = removeLastOccurrence(out, "**");
  }
  if (countOccurrences(out, "~~") % 2 === 1) {
    out = removeLastOccurrence(out, "~~");
  }
  const singleStars =
    countOccurrences(out, "*") - 2 * countOccurrences(out, "**");
  if (singleStars % 2 === 1) {
    out = removeLastOccurrence(out, "*");
  }
  return out;
};

const toSummaryExcerpt = (result: string): string => {
  const compact = stripBlockMarkdown(result).replace(/\s+/g, " ").trim();
  if (compact.length <= SUMMARY_MAX_CHARS) {
    return dropDanglingInlineMarkers(compact);
  }
  // Prefer a word boundary near the cap; otherwise cut between graphemes.
  const head = truncateAtGrapheme(compact, SUMMARY_MAX_CHARS);
  const lastSpace = head.lastIndexOf(" ");
  const cut =
    lastSpace >= SUMMARY_MAX_CHARS - SUMMARY_BOUNDARY_SLACK
      ? head.slice(0, lastSpace)
      : head;
  return `${dropDanglingInlineMarkers(cut.trimEnd()).trimEnd()}…`;
};

/**
 * Build the sectioned completion card for a row: one section per agent that
 * COMPLETED at this point, in first-completion order. Deliberately not
 * gated on produced files: an agent that finished without any observable
 * file output (purely investigative work, or an engine whose writes Stella
 * can't track — e.g. vanilla Claude Code Bash-side writes) still gets its
 * "done" card; files enrich the card when present, and a fileless section
 * carries a compact `summary` excerpt of the agent's result instead.
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

  // Enumerate completed agents from the row's `agent-completed` events (in
  // first-completion order), tracking each agent's latest completion
  // timestamp and the result excerpt from that latest completion.
  const completedAgentIds: string[] = [];
  const completedAtByAgent = new Map<string, number>();
  const completionEventIdByAgent = new Map<string, string>();
  const rootRunIdByAgent = new Map<string, string>();
  const summaryByAgent = new Map<string, string>();
  for (const event of toolEvents) {
    if (!isAgentCompletedEvent(event)) continue;
    const agentId = asNonEmptyString(event.payload.agentId);
    if (!agentId) continue;
    const prev = completedAtByAgent.get(agentId);
    if (prev === undefined) completedAgentIds.push(agentId);
    if (prev === undefined || event.timestamp >= prev) {
      completedAtByAgent.set(agentId, Math.max(prev ?? 0, event.timestamp));
      completionEventIdByAgent.set(agentId, event._id);
      const rootRunId = asNonEmptyString(event.payload.rootRunId);
      if (rootRunId) rootRunIdByAgent.set(agentId, rootRunId);
      else rootRunIdByAgent.delete(agentId);
      const result = asNonEmptyString(event.payload.result);
      // The summary always mirrors the LATEST completion: a re-run that
      // finishes without a result clears the older excerpt rather than
      // leaving stale text attributed to the newer completion.
      if (result) summaryByAgent.set(agentId, toSummaryExcerpt(result));
      else summaryByAgent.delete(agentId);
    }
  }

  const sections: AgentCompletionSection[] = [];
  for (const agentId of completedAgentIds) {
    const meta = agentMetaById.get(agentId);
    const title =
      meta?.description?.trim() ||
      meta?.groupLabel?.trim() ||
      fallbackTaskDescription(agentId);
    const entries = files.get(agentId) ?? [];
    const summary = summaryByAgent.get(agentId);
    sections.push({
      agentId,
      ...(meta?.agentType ? { agentType: meta.agentType } : {}),
      title,
      completedAtMs: completedAtByAgent.get(agentId) ?? 0,
      ...(completionEventIdByAgent.get(agentId)
        ? { completionEventId: completionEventIdByAgent.get(agentId) }
        : {}),
      ...(rootRunIdByAgent.get(agentId)
        ? { rootRunId: rootRunIdByAgent.get(agentId) }
        : {}),
      files: rankDeliverablesFirst([...entries]),
      ...(summary ? { summary } : {}),
    });
  }
  return sections;
}
