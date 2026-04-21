/**
 * ThreadSummariesStore — Stage 1 SQLite store of subagent rollout summaries.
 *
 * Each completed subagent run (typically a General agent task) records one row
 * keyed by (thread_id, run_id). The Dream protocol later consolidates these
 * unprocessed rows into the on-disk markdown memory layout under
 * `state/memories/`.
 *
 * The store is intentionally tiny — it is a queue, not a search index.
 */

import type { SqliteDatabase } from "../storage/shared.js";

export type ThreadSummaryRow = {
  threadId: string;
  runId: string;
  agentType: string;
  rolloutSummary: string;
  rawMemory: string | null;
  sourceUpdatedAt: number;
  processedByDreamAt: number | null;
  dreamWatermark: number | null;
  usageCount: number;
  lastUsage: number | null;
};

export type RecordArgs = {
  threadId: string;
  runId: string;
  agentType: string;
  rolloutSummary: string;
  rawMemory?: string | null;
};

export type MarkProcessedArgs = {
  threadIds?: string[];
  threadKeys?: Array<{ threadId: string; runId: string }>;
  watermark?: number;
  processedAt?: number;
};

export type MarkProcessedResult = {
  updated: number;
  watermark: number;
  maxSourceUpdatedAt: number;
};

type ThreadSummaryRawRow = {
  thread_id: string;
  run_id: string;
  agent_type: string;
  rollout_summary: string;
  raw_memory: string | null;
  source_updated_at: number;
  processed_by_dream_at: number | null;
  dream_watermark: number | null;
  usage_count: number;
  last_usage: number | null;
};

const fromRow = (row: ThreadSummaryRawRow): ThreadSummaryRow => ({
  threadId: row.thread_id,
  runId: row.run_id,
  agentType: row.agent_type,
  rolloutSummary: row.rollout_summary,
  rawMemory: row.raw_memory,
  sourceUpdatedAt: row.source_updated_at,
  processedByDreamAt: row.processed_by_dream_at,
  dreamWatermark: row.dream_watermark,
  usageCount: row.usage_count,
  lastUsage: row.last_usage,
});

export class ThreadSummariesStore {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Insert or replace a summary for (thread_id, run_id).
   *
   * `rolloutSummary` is the General agent's final output text — the rollout
   * summary that Dream consolidates into `state/memories/MEMORY.md`.
   * `rawMemory` is reserved for the Dream agent to fill in later if useful.
   */
  record(args: RecordArgs): void {
    const summary = args.rolloutSummary.trim();
    if (!summary) return;
    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO thread_summaries (
          thread_id,
          run_id,
          agent_type,
          rollout_summary,
          raw_memory,
          source_updated_at,
          processed_by_dream_at,
          dream_watermark,
          usage_count,
          last_usage
        )
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL)
        ON CONFLICT(thread_id, run_id) DO UPDATE SET
          agent_type = excluded.agent_type,
          rollout_summary = excluded.rollout_summary,
          raw_memory = COALESCE(excluded.raw_memory, raw_memory),
          source_updated_at = excluded.source_updated_at,
          processed_by_dream_at = NULL,
          dream_watermark = NULL
        `,
      )
      .run(
        args.threadId,
        args.runId,
        args.agentType,
        summary,
        args.rawMemory ?? null,
        now,
      );
  }

  /**
   * Return rows newer than `sinceWatermark` (exclusive) that have not yet been
   * processed by the Dream agent. Caller decides how many to claim per run.
   */
  listUnprocessed(args?: { sinceWatermark?: number; limit?: number }): ThreadSummaryRow[] {
    const since = args?.sinceWatermark ?? 0;
    const limit = Math.max(1, Math.min(args?.limit ?? 100, 500));
    const rows = this.db
      .prepare(
        `
        SELECT
          thread_id,
          run_id,
          agent_type,
          rollout_summary,
          raw_memory,
          source_updated_at,
          processed_by_dream_at,
          dream_watermark,
          usage_count,
          last_usage
        FROM thread_summaries
        WHERE processed_by_dream_at IS NULL
          AND source_updated_at > ?
        ORDER BY source_updated_at ASC
        LIMIT ?
        `,
      )
      .all(since, limit) as ThreadSummaryRawRow[];
    return rows.map(fromRow);
  }

  /**
   * Return the count of unprocessed rows. Used by the Dream scheduler to
   * decide whether to fire a new run.
   */
  countUnprocessed(sinceWatermark = 0): number {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS c
        FROM thread_summaries
        WHERE processed_by_dream_at IS NULL
          AND source_updated_at > ?
        `,
      )
      .get(sinceWatermark) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  }

  /**
   * Mark rows as processed. Either pass concrete (threadId, runId) keys or
   * a list of threadIds (any matching unprocessed run). The watermark is
   * stamped on the rows so a future incremental Dream run can resume.
   */
  markProcessed(args: MarkProcessedArgs): MarkProcessedResult {
    const processedAt = args.processedAt ?? Date.now();
    let updated = 0;
    let maxSourceUpdatedAt = 0;

    this.db.exec("BEGIN TRANSACTION;");
    try {
      if (args.threadKeys && args.threadKeys.length > 0) {
        const maxStmt = this.db.prepare(
          `
          SELECT MAX(source_updated_at) AS m
          FROM thread_summaries
          WHERE thread_id = ? AND run_id = ? AND processed_by_dream_at IS NULL
          `,
        );
        for (const key of args.threadKeys) {
          const maxRow = maxStmt.get(key.threadId, key.runId) as
            | { m?: number | null }
            | undefined;
          maxSourceUpdatedAt = Math.max(
            maxSourceUpdatedAt,
            Number(maxRow?.m ?? 0),
          );
        }
      }
      if (args.threadIds && args.threadIds.length > 0) {
        const maxStmt = this.db.prepare(
          `
          SELECT MAX(source_updated_at) AS m
          FROM thread_summaries
          WHERE thread_id = ? AND processed_by_dream_at IS NULL
          `,
        );
        for (const threadId of args.threadIds) {
          const maxRow = maxStmt.get(threadId) as
            | { m?: number | null }
            | undefined;
          maxSourceUpdatedAt = Math.max(
            maxSourceUpdatedAt,
            Number(maxRow?.m ?? 0),
          );
        }
      }

      const watermark =
        args.watermark ??
        (maxSourceUpdatedAt > 0 ? maxSourceUpdatedAt : processedAt);

      if (args.threadKeys && args.threadKeys.length > 0) {
        const stmt = this.db.prepare(
          `
          UPDATE thread_summaries
          SET processed_by_dream_at = ?, dream_watermark = ?
          WHERE thread_id = ? AND run_id = ? AND processed_by_dream_at IS NULL
          `,
        );
        for (const key of args.threadKeys) {
          const result = stmt.run(processedAt, watermark, key.threadId, key.runId) as
            | { changes?: number }
            | undefined;
          updated += Number(result?.changes ?? 0);
        }
      }
      if (args.threadIds && args.threadIds.length > 0) {
        const stmt = this.db.prepare(
          `
          UPDATE thread_summaries
          SET processed_by_dream_at = ?, dream_watermark = ?
          WHERE thread_id = ? AND processed_by_dream_at IS NULL
          `,
        );
        for (const threadId of args.threadIds) {
          const result = stmt.run(processedAt, watermark, threadId) as
            | { changes?: number }
            | undefined;
          updated += Number(result?.changes ?? 0);
        }
      }
      this.db.exec("COMMIT;");
      return { updated, watermark, maxSourceUpdatedAt };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  /**
   * Update usage counters when the Orchestrator surfaces a thread summary in
   * its working context. Pure bookkeeping; never throws on missing rows.
   */
  recordUsage(threadId: string, runId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `
        UPDATE thread_summaries
        SET usage_count = usage_count + 1, last_usage = ?
        WHERE thread_id = ? AND run_id = ?
        `,
      )
      .run(now, threadId, runId);
  }

  /**
   * Maximum source_updated_at we have seen, useful to seed the next
   * watermark when starting a new Dream run.
   */
  latestSourceUpdatedAt(): number {
    const row = this.db
      .prepare(`SELECT MAX(source_updated_at) AS m FROM thread_summaries`)
      .get() as { m?: number | null } | undefined;
    return Number(row?.m ?? 0);
  }
}
