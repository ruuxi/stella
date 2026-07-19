/**
 * DreamInboxStore — the single durable queue of everything the Dream agent
 * consolidates into `~/.stella/memories/`.
 *
 * Three kinds of rows flow through it:
 *   - `thread_summary` — one row per finalized subagent run (upserted by
 *     (threadId, runId); re-recording a run resets its processed state).
 *   - `memory_note`    — one row per orchestrator memory-review candidate.
 *   - `chronicle`      — the rolling screen-activity digest per window
 *     ("10m"/"6h"); upserted by window so refreshes coalesce into one
 *     unprocessed row instead of flooding the queue.
 *
 * `processed_by_dream_at IS NULL` is the entire queue state. There is no
 * separate watermark file or per-file mtime tracking; Dream lists unprocessed
 * rows and marks them processed by id.
 *
 * The store is intentionally tiny — it is a queue, not a search index.
 */

import type { SqliteDatabase } from "../storage/shared.js";
import { redactMemoryText, redactMemoryStringArray } from "./redaction.js";

export type DreamInboxKind = "thread_summary" | "memory_note" | "chronicle";

export type DreamInboxRow = {
  id: number;
  kind: DreamInboxKind;
  sourceKey: string;
  threadId: string | null;
  runId: string | null;
  agentType: string | null;
  title: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  /**
   * Reporting conversation (subagent rows: the parent's conversation, whose
   * window holds the byte-equivalent report). Null on legacy rows recorded
   * before the column existed — those are never mechanically consumed by
   * the delta pass and always flow through the model-driven list path.
   */
  conversationId: string | null;
  sourceUpdatedAt: number;
  processedByDreamAt: number | null;
  usageCount: number;
  lastUsage: number | null;
};

export type RecordThreadSummaryArgs = {
  threadId: string;
  runId: string;
  agentType: string;
  rolloutSummary: string;
  /** Reporting conversation; enables delta-covered consumption scoping. */
  conversationId?: string;
};

export type MemoryNoteCandidate = {
  title: string;
  category: string;
  memory: string;
  recallHooks: string[];
  evidence: string[];
  createdAt?: Date;
};

export type RecordChronicleSummaryArgs = {
  window: string;
  content: string;
  uniqueLines?: number;
};

type DreamInboxRawRow = {
  id: number;
  kind: string;
  source_key: string;
  thread_id: string | null;
  run_id: string | null;
  agent_type: string | null;
  title: string | null;
  content: string;
  metadata: string | null;
  conversation_id: string | null;
  source_updated_at: number;
  processed_by_dream_at: number | null;
  usage_count: number;
  last_usage: number | null;
};

const ROW_COLUMNS = `
  id,
  kind,
  source_key,
  thread_id,
  run_id,
  agent_type,
  title,
  content,
  metadata,
  conversation_id,
  source_updated_at,
  processed_by_dream_at,
  usage_count,
  last_usage
`;

export const DREAM_USAGE_REQUEUE_DEBOUNCE_MS = 6 * 60 * 60 * 1_000;

/**
 * Retention for consumed inbox rows (design review §6.1 / migration #10:
 * "processed rows GC'd >30d"). A processed row's payload is already durably
 * represented elsewhere — the orchestrator window / transcript FTS holds the
 * byte-equivalent report, and Dream folded whatever mattered into MEMORY.md —
 * so after 30 days the row is pure at-rest duplication (4.4MB measured live).
 */
export const DREAM_INBOX_GC_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const parseMetadata = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const fromRow = (row: DreamInboxRawRow): DreamInboxRow => ({
  id: row.id,
  kind: row.kind as DreamInboxKind,
  sourceKey: row.source_key,
  threadId: row.thread_id,
  runId: row.run_id,
  agentType: row.agent_type,
  title: row.title,
  content: row.content,
  metadata: parseMetadata(row.metadata),
  conversationId: row.conversation_id,
  sourceUpdatedAt: row.source_updated_at,
  processedByDreamAt: row.processed_by_dream_at,
  usageCount: row.usage_count,
  lastUsage: row.last_usage,
});

const NOTE_SLUG_MAX_CHARS = 80;

const slugify = (input: string): string => {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NOTE_SLUG_MAX_CHARS)
    .replace(/-+$/g, "");
  return slug || "memory-note";
};

const formatList = (items: string[]): string =>
  items.length > 0
    ? items.map((item) => `- ${item.trim()}`).join("\n")
    : "- None";

const formatMemoryNote = (note: Required<MemoryNoteCandidate>): string =>
  [
    `- title: ${note.title}`,
    `- category: ${note.category}`,
    `- created_at: ${note.createdAt.toISOString()}`,
    "- source: Orchestrator conversation review",
    "",
    "## Candidate",
    note.memory,
    "",
    "## Recall hooks",
    formatList(note.recallHooks),
    "",
    "## Evidence",
    formatList(note.evidence),
  ].join("\n");

export class DreamInboxStore {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Insert or replace the rollout summary for (threadId, runId).
   *
   * `rolloutSummary` is the subagent's final output text. Re-recording the
   * same run replaces the content and resets the processed state so Dream
   * picks the freshest version up again.
   */
  recordThreadSummary(args: RecordThreadSummaryArgs): void {
    const summary = redactMemoryText(args.rolloutSummary.trim());
    if (!summary) return;
    this.upsert({
      kind: "thread_summary",
      sourceKey: `${args.threadId}:${args.runId}`,
      threadId: args.threadId,
      runId: args.runId,
      agentType: args.agentType,
      title: null,
      content: summary,
      metadata: null,
      conversationId: args.conversationId?.trim() || null,
    });
  }

  /**
   * Queue an orchestrator memory-review candidate. Each note is its own row
   * (no coalescing); the formatted markdown body is what Dream and the
   * known-memory context read.
   */
  recordMemoryNote(
    candidate: MemoryNoteCandidate,
    opts?: { conversationId?: string },
  ): { id: number } {
    const title = redactMemoryText(candidate.title.trim());
    const memory = redactMemoryText(candidate.memory.trim());
    if (!title) throw new Error("title must not be empty.");
    if (!memory) throw new Error("memory must not be empty.");

    const createdAt = candidate.createdAt ?? new Date();
    const note: Required<MemoryNoteCandidate> = {
      title,
      category: redactMemoryText(candidate.category.trim()) || "active_focus",
      memory,
      recallHooks: redactMemoryStringArray(
        candidate.recallHooks.map((hook) => hook.trim()).filter(Boolean),
      ),
      evidence: redactMemoryStringArray(
        candidate.evidence.map((item) => item.trim()).filter(Boolean),
      ),
      createdAt,
    };
    const baseKey = `${createdAt.getTime()}-${slugify(title)}`;
    const content = formatMemoryNote(note);
    const metadata = JSON.stringify({
      category: note.category,
      recallHooks: note.recallHooks,
      evidence: note.evidence,
    });

    const conversationId = opts?.conversationId?.trim() || null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const sourceKey = attempt === 0 ? baseKey : `${baseKey}-${attempt + 1}`;
      const result = this.db
        .prepare(
          `
          INSERT INTO dream_inbox (
            kind, source_key, thread_id, run_id, agent_type, title,
            content, metadata, conversation_id, source_updated_at,
            processed_by_dream_at, usage_count, last_usage
          )
          VALUES ('memory_note', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, 0, NULL)
          ON CONFLICT(kind, source_key) DO NOTHING
          `,
        )
        .run(
          sourceKey,
          note.title,
          content,
          metadata,
          conversationId,
          createdAt.getTime(),
        ) as
        | { changes?: number; lastInsertRowid?: number | bigint }
        | undefined;
      if (Number(result?.changes ?? 0) > 0) {
        return { id: Number(result?.lastInsertRowid ?? 0) };
      }
    }
    throw new Error("could not create a unique memory note key.");
  }

  /**
   * Upsert the rolling chronicle digest for a window. Refreshes overwrite the
   * window's row and reset its processed state, so however often the
   * summarizer runs, Dream only ever sees the latest digest once.
   */
  recordChronicleSummary(args: RecordChronicleSummaryArgs): void {
    const content = redactMemoryText(args.content.trim());
    if (!content) return;
    this.upsert({
      kind: "chronicle",
      sourceKey: args.window,
      threadId: null,
      runId: null,
      agentType: null,
      title: `Chronicle ${args.window} screen-activity digest`,
      content,
      metadata: JSON.stringify({
        window: args.window,
        ...(typeof args.uniqueLines === "number"
          ? { uniqueLines: args.uniqueLines }
          : {}),
      }),
    });
  }

  private upsert(args: {
    kind: DreamInboxKind;
    sourceKey: string;
    threadId: string | null;
    runId: string | null;
    agentType: string | null;
    title: string | null;
    content: string;
    metadata: string | null;
    conversationId?: string | null;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO dream_inbox (
          kind, source_key, thread_id, run_id, agent_type, title,
          content, metadata, conversation_id, source_updated_at,
          processed_by_dream_at, usage_count, last_usage
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)
        ON CONFLICT(kind, source_key) DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = excluded.run_id,
          agent_type = excluded.agent_type,
          title = excluded.title,
          content = excluded.content,
          metadata = excluded.metadata,
          conversation_id = excluded.conversation_id,
          source_updated_at = excluded.source_updated_at,
          processed_by_dream_at = NULL
        `,
      )
      .run(
        args.kind,
        args.sourceKey,
        args.threadId,
        args.runId,
        args.agentType,
        args.title,
        args.content,
        args.metadata,
        args.conversationId ?? null,
        Date.now(),
      );
  }

  /**
   * Frequently surfaced rows lead, then the remaining queue is oldest-first.
   * This makes Dream retain and refresh memory that repeatedly proves useful.
   *
   * `excludeConversationKinds` hides the rows a delta-input pass reads from
   * its orchestrator delta instead (same conversation, covered kinds, newer
   * than the watermark the pass derives from), so the model is not
   * double-fed. Everything else — chronicle transport, rows reported by
   * OTHER conversations, legacy NULL-conversation rows, and pre-window rows
   * whose span may only ever have been shadow-covered — still flows through
   * this list to the model-driven markProcessed path exactly like the
   * pre-migration inbox pass.
   */
  listUnprocessed(args?: {
    limit?: number;
    excludeConversationKinds?: {
      conversationId: string;
      kinds: readonly DreamInboxKind[];
      /** Exclusive lower bound; rows at/below it are NOT hidden. */
      sinceTs: number;
    };
  }): DreamInboxRow[] {
    const limit = Math.max(1, Math.min(args?.limit ?? 50, 500));
    const exclude =
      args?.excludeConversationKinds &&
      args.excludeConversationKinds.kinds.length > 0
        ? {
            conversationId: args.excludeConversationKinds.conversationId,
            kinds: [...new Set(args.excludeConversationKinds.kinds)],
            sinceTs: Math.max(0, args.excludeConversationKinds.sinceTs),
          }
        : null;
    // NULL-safe (`IS NOT`): a legacy row with no conversation matches no
    // exclusion — plain `NOT (conversation_id = ?)` would evaluate to NULL
    // and silently hide exactly the rows that must stay on the model path.
    const excludeFilter = exclude
      ? ` AND (conversation_id IS NOT ? OR kind NOT IN (${exclude.kinds
          .map(() => "?")
          .join(", ")}) OR source_updated_at <= ?)`
      : "";
    const rows = this.db
      .prepare(
        `
        SELECT ${ROW_COLUMNS}
        FROM dream_inbox
        WHERE processed_by_dream_at IS NULL${excludeFilter}
        ORDER BY usage_count DESC, COALESCE(last_usage, 0) DESC,
                 source_updated_at ASC, id ASC
        LIMIT ?
        `,
      )
      .all(
        ...(exclude
          ? [exclude.conversationId, ...exclude.kinds, exclude.sinceTs]
          : []),
        limit,
      ) as DreamInboxRawRow[];
    return rows.map(fromRow);
  }

  /**
   * Newest pending material: max `source_updated_at` across unprocessed rows,
   * or 0 when the queue is drained. The consolidate-before-compact ordering
   * compares this frontier against the persisted pass watermark to decide
   * whether awaiting a Dream pass could still improve checkpoint freshness.
   */
  pendingFrontier(): number {
    const row = this.db
      .prepare(
        `SELECT MAX(source_updated_at) AS frontier FROM dream_inbox WHERE processed_by_dream_at IS NULL`,
      )
      .get() as { frontier?: number | null } | undefined;
    return Number(row?.frontier ?? 0);
  }

  /**
   * Last completed Dream pass, as the pending frontier captured when that
   * pass STARTED (conservative: rows arriving mid-pass stay ahead of the
   * watermark). Null until a pass has ever completed.
   */
  readConsolidationWatermark(): { frontier: number; completedAt: number } | null {
    const row = this.db
      .prepare(
        `SELECT frontier, completed_at FROM dream_consolidation_watermark WHERE id = 1`,
      )
      .get() as { frontier?: number; completed_at?: number } | undefined;
    if (row === undefined || typeof row.frontier !== "number") return null;
    return {
      frontier: row.frontier,
      completedAt: Number(row.completed_at ?? 0),
    };
  }

  /**
   * Advance the pass watermark after a completed consolidation. Monotonic:
   * a delayed writer can never move the frontier backwards. Purely a
   * freshness signal — per-row `processed_by_dream_at` alone decides what
   * Dream consumes, so a lost or stale watermark can cost an extra (or a
   * skipped) best-effort pre-compaction pass, never facts.
   */
  writeConsolidationWatermark(args: {
    frontier: number;
    completedAt?: number;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO dream_consolidation_watermark (id, frontier, completed_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          frontier = MAX(dream_consolidation_watermark.frontier, excluded.frontier),
          completed_at = excluded.completed_at
        `,
      )
      .run(args.frontier, args.completedAt ?? Date.now());
  }

  /**
   * Persisted message-timestamp watermark for the orchestrator-delta input
   * (migration step 6): newest thread message a completed delta derivation
   * (shadow or live) covered for this conversation. 0 until the first pass.
   */
  readDeltaWatermark(conversationId: string): number {
    const row = this.db
      .prepare(
        `SELECT last_message_ts FROM dream_delta_watermark WHERE conversation_id = ?`,
      )
      .get(conversationId) as { last_message_ts?: number } | undefined;
    const ts = Number(row?.last_message_ts ?? 0);
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  }

  /**
   * Advance the delta watermark. Monotonic — a delayed or racing writer can
   * never move coverage backwards, mirroring the memory-review watermark.
   */
  advanceDeltaWatermark(conversationId: string, lastMessageTs: number): void {
    if (!Number.isFinite(lastMessageTs) || lastMessageTs <= 0) return;
    this.db
      .prepare(
        `
        INSERT INTO dream_delta_watermark (conversation_id, last_message_ts, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          last_message_ts = MAX(dream_delta_watermark.last_message_ts, excluded.last_message_ts),
          updated_at = excluded.updated_at
        `,
      )
      .run(conversationId, Math.floor(lastMessageTs), Date.now());
  }

  /**
   * Persisted token baseline for the scheduler's token_interval gate; null
   * until a Dream run has ever recorded one. Fixes the in-memory reset where
   * every worker restart made the next gate measure growth from zero.
   */
  readTokenBaseline(): number | null {
    const row = this.db
      .prepare(`SELECT tokens_at_last_run FROM dream_scheduler_state WHERE id = 1`)
      .get() as { tokens_at_last_run?: number } | undefined;
    const tokens = Number(row?.tokens_at_last_run);
    return Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
  }

  /** Write-through of the scheduler's token baseline. Last write wins — the
   * baseline legitimately moves DOWN when a compaction shrinks the thread. */
  writeTokenBaseline(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) return;
    this.db
      .prepare(
        `
        INSERT INTO dream_scheduler_state (id, tokens_at_last_run, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          tokens_at_last_run = excluded.tokens_at_last_run,
          updated_at = excluded.updated_at
        `,
      )
      .run(Math.floor(tokens), Date.now());
  }

  /**
   * Newest `source_updated_at` among rows a pass actually consumed since it
   * started. The scheduler advances the pass watermark to this (never past
   * it), so a >LIST-limit backlog can no longer advance the watermark past
   * rows the pass never saw.
   */
  maxProcessedSourceUpdatedAtSince(sinceMs: number): number {
    const row = this.db
      .prepare(
        `
        SELECT MAX(source_updated_at) AS frontier
        FROM dream_inbox
        WHERE processed_by_dream_at IS NOT NULL AND processed_by_dream_at >= ?
        `,
      )
      .get(sinceMs) as { frontier?: number | null } | undefined;
    return Number(row?.frontier ?? 0);
  }

  /**
   * Code-level consumption for the delta-input pass, scoped to the delta's
   * OWN conversation AND its own derivation window: a row reported by
   * conversation C at time T derives from C's messages ≤ T, so
   * `conversation_id = C AND sinceTs < source_updated_at ≤ coveredThroughTs`
   * ⇒ its content is provably inside the span an APPLIED derivation just
   * read. Rows at or below `sinceTs` are never consumed — their span may
   * have been covered only by shadow passes, whose proposals are discarded
   * by design — and rows from other conversations / legacy NULL rows are
   * never touched: all of those stay queued for the model-driven list path.
   * Rows arriving mid-pass carry a later timestamp and stay queued too.
   *
   * Timestamp-domain caveat (accepted): `source_updated_at` is the hook's
   * wall clock while coverage is message timestamps, and the row can be
   * written moments BEFORE its report message lands in the orchestrator
   * thread. A pass racing that gap can consume the row while the report
   * text sits just above coverage — the report is then derived by the next
   * pass (both clocks are the same machine's; the gap is milliseconds).
   * Freshness lag, never loss.
   */
  markKindsProcessedThrough(args: {
    conversationId: string;
    kinds: readonly DreamInboxKind[];
    /** Exclusive lower bound: the watermark the delta pass started from. */
    sinceTs: number;
    throughTs: number;
    processedAt?: number;
  }): { updated: number } {
    const conversationId = args.conversationId.trim();
    if (
      !conversationId ||
      args.kinds.length === 0 ||
      !(args.throughTs > 0) ||
      !(args.sinceTs >= 0) ||
      args.throughTs <= args.sinceTs
    ) {
      return { updated: 0 };
    }
    const kinds = [...new Set(args.kinds)];
    const result = this.db
      .prepare(
        `
        UPDATE dream_inbox
        SET processed_by_dream_at = ?
        WHERE processed_by_dream_at IS NULL
          AND conversation_id = ?
          AND kind IN (${kinds.map(() => "?").join(", ")})
          AND source_updated_at > ?
          AND source_updated_at <= ?
        `,
      )
      .run(
        args.processedAt ?? Date.now(),
        conversationId,
        ...kinds,
        args.sinceTs,
        args.throughTs,
      ) as { changes?: number } | undefined;
    return { updated: Number(result?.changes ?? 0) };
  }

  /** Count of unprocessed rows; the Dream scheduler's eligibility gate. */
  countUnprocessed(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM dream_inbox WHERE processed_by_dream_at IS NULL`,
      )
      .get() as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  }

  /** Stamp rows as consumed by Dream. Returns how many rows were updated. */
  markProcessed(args: { ids: number[]; processedAt?: number }): {
    updated: number;
  } {
    if (args.ids.length === 0) return { updated: 0 };
    const processedAt = args.processedAt ?? Date.now();
    const stmt = this.db.prepare(
      `
      UPDATE dream_inbox
      SET processed_by_dream_at = ?
      WHERE id = ? AND processed_by_dream_at IS NULL
      `,
    );
    let updated = 0;
    this.db.exec("BEGIN TRANSACTION;");
    try {
      for (const id of args.ids) {
        const result = stmt.run(processedAt, id) as
          | { changes?: number }
          | undefined;
        updated += Number(result?.changes ?? 0);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return { updated };
  }

  /**
   * Garbage-collect rows Dream consumed more than `retentionMs` ago.
   *
   * Scope guards, all deliberate:
   *   - Unprocessed rows are NEVER touched — the queue state is sacred; a
   *     row missed by every pass so far still gets consolidated eventually.
   *   - Rows surfaced to the orchestrator within the retention window
   *     (`last_usage`) are kept: usage is the retention signal the usage
   *     ledger half-built, and recently-useful summaries stay resolvable by
   *     `findThreadSummariesByThreadIds`.
   *   - `chronicle` rows are exempt — Chronicle transport is out of scope
   *     and its per-window upsert keying already bounds it to a handful of
   *     rows, so exempting it costs nothing.
   */
  gcProcessedRows(args?: { retentionMs?: number; nowMs?: number }): {
    deleted: number;
  } {
    const retentionMs = Math.max(
      0,
      args?.retentionMs ?? DREAM_INBOX_GC_RETENTION_MS,
    );
    const cutoff = (args?.nowMs ?? Date.now()) - retentionMs;
    const result = this.db
      .prepare(
        `
        DELETE FROM dream_inbox
        WHERE processed_by_dream_at IS NOT NULL
          AND processed_by_dream_at < ?
          AND (last_usage IS NULL OR last_usage < ?)
          AND kind != 'chronicle'
        `,
      )
      .run(cutoff, cutoff) as { changes?: number } | undefined;
    return { deleted: Number(result?.changes ?? 0) };
  }

  /**
   * Most recent thread summaries by source_updated_at regardless of
   * processed state. Used by background passes that want a "what has the
   * user been doing lately" snapshot.
   */
  listRecentThreadSummaries(args?: { limit?: number }): DreamInboxRow[] {
    const limit = Math.max(1, Math.min(args?.limit ?? 20, 200));
    const rows = this.db
      .prepare(
        `
        SELECT ${ROW_COLUMNS}
        FROM dream_inbox
        WHERE kind = 'thread_summary'
        ORDER BY source_updated_at DESC
        LIMIT ?
        `,
      )
      .all(limit) as DreamInboxRawRow[];
    return rows.map(fromRow);
  }

  /** Resolve the newest summary for each exact surfaced thread id. */
  findThreadSummariesByThreadIds(
    threadIds: readonly string[],
  ): DreamInboxRow[] {
    const ids = [
      ...new Set(threadIds.map((id) => id.trim()).filter(Boolean)),
    ].slice(0, 100);
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `
        SELECT ${ROW_COLUMNS}
        FROM dream_inbox
        WHERE kind = 'thread_summary'
          AND thread_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY source_updated_at DESC, id DESC
        `,
      )
      .all(...ids) as DreamInboxRawRow[];
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      if (!row.thread_id || seen.has(row.thread_id)) return [];
      seen.add(row.thread_id);
      return [fromRow(row)];
    });
  }

  /**
   * Newest-first memory-note bodies, consolidated or not. The memory-review
   * pass includes these in its known-memory context so it does not re-propose
   * a candidate Dream has not folded yet.
   */
  listRecentMemoryNotes(limit = 8): string[] {
    if (limit <= 0) return [];
    const rows = this.db
      .prepare(
        `
        SELECT content
        FROM dream_inbox
        WHERE kind = 'memory_note'
        ORDER BY source_updated_at DESC, id DESC
        LIMIT ?
        `,
      )
      .all(Math.min(limit, 50)) as Array<{ content: string }>;
    return rows.map((row) => row.content).filter(Boolean);
  }

  /**
   * Update usage counters when the Orchestrator surfaces a thread summary in
   * its working context. Pure bookkeeping; never throws on missing rows.
   */
  recordUsage(
    threadId: string,
    runId: string,
    options?: { nowMs?: number; requeueDebounceMs?: number },
  ): void {
    const nowMs = options?.nowMs ?? Date.now();
    const requeueDebounceMs = Math.max(
      0,
      options?.requeueDebounceMs ?? DREAM_USAGE_REQUEUE_DEBOUNCE_MS,
    );
    this.db
      .prepare(
        `
        UPDATE dream_inbox
        SET usage_count = usage_count + 1,
            last_usage = ?,
            processed_by_dream_at = CASE
              WHEN last_usage IS NULL OR last_usage <= ? THEN NULL
              ELSE processed_by_dream_at
            END
        WHERE kind = 'thread_summary' AND thread_id = ? AND run_id = ?
        `,
      )
      .run(nowMs, nowMs - requeueDebounceMs, threadId, runId);
  }
}
