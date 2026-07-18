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
  source_updated_at,
  processed_by_dream_at,
  usage_count,
  last_usage
`;

export const DREAM_USAGE_REQUEUE_DEBOUNCE_MS = 6 * 60 * 60 * 1_000;

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
    });
  }

  /**
   * Queue an orchestrator memory-review candidate. Each note is its own row
   * (no coalescing); the formatted markdown body is what Dream and the
   * known-memory context read.
   */
  recordMemoryNote(candidate: MemoryNoteCandidate): { id: number } {
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

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const sourceKey = attempt === 0 ? baseKey : `${baseKey}-${attempt + 1}`;
      const result = this.db
        .prepare(
          `
          INSERT INTO dream_inbox (
            kind, source_key, thread_id, run_id, agent_type, title,
            content, metadata, source_updated_at, processed_by_dream_at,
            usage_count, last_usage
          )
          VALUES ('memory_note', ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, 0, NULL)
          ON CONFLICT(kind, source_key) DO NOTHING
          `,
        )
        .run(sourceKey, note.title, content, metadata, createdAt.getTime()) as
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
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO dream_inbox (
          kind, source_key, thread_id, run_id, agent_type, title,
          content, metadata, source_updated_at, processed_by_dream_at,
          usage_count, last_usage
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)
        ON CONFLICT(kind, source_key) DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = excluded.run_id,
          agent_type = excluded.agent_type,
          title = excluded.title,
          content = excluded.content,
          metadata = excluded.metadata,
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
        Date.now(),
      );
  }

  /**
   * Frequently surfaced rows lead, then the remaining queue is oldest-first.
   * This makes Dream retain and refresh memory that repeatedly proves useful.
   */
  listUnprocessed(args?: { limit?: number }): DreamInboxRow[] {
    const limit = Math.max(1, Math.min(args?.limit ?? 50, 500));
    const rows = this.db
      .prepare(
        `
        SELECT ${ROW_COLUMNS}
        FROM dream_inbox
        WHERE processed_by_dream_at IS NULL
        ORDER BY usage_count DESC, COALESCE(last_usage, 0) DESC,
                 source_updated_at ASC, id ASC
        LIMIT ?
        `,
      )
      .all(limit) as DreamInboxRawRow[];
    return rows.map(fromRow);
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
