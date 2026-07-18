import type { TranscriptSearchHit } from "./runtime-store.js";
import type { SqliteDatabase } from "./shared.js";

const TRANSCRIPT_TEXT_CAP = 4_000;

export type RecallFtsHealth = {
  healthy: boolean;
  transcriptReady: boolean;
  threadsReady: boolean;
  reason?: string;
};

/**
 * Recall must never accidentally enter SessionStore's slow LIKE fallback.
 * This read-only preflight turns a missing table or incomplete backfill into
 * a visible retrieval failure instead.
 */
export const readRecallFtsHealth = (db: SqliteDatabase): RecallFtsHealth => {
  const tableRows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('message_text_fts', 'thread_search_fts')`,
    )
    .all() as Array<{ name?: string }>;
  const tables = new Set(tableRows.map((row) => row.name));
  const flagRows = db
    .prepare(
      `SELECT key FROM settings
       WHERE key IN ('transcript_fts_backfilled_v1', 'thread_search_fts_backfilled_v1')`,
    )
    .all() as Array<{ key?: string }>;
  const flags = new Set(flagRows.map((row) => row.key));
  const transcriptReady =
    tables.has("message_text_fts") && flags.has("transcript_fts_backfilled_v1");
  const threadsReady =
    tables.has("thread_search_fts") &&
    flags.has("thread_search_fts_backfilled_v1");
  return {
    healthy: transcriptReady && threadsReady,
    transcriptReady,
    threadsReady,
    ...(!transcriptReady || !threadsReady
      ? {
          reason: [
            !transcriptReady ? "transcript FTS missing or not backfilled" : "",
            !threadsReady ? "thread FTS missing or not backfilled" : "",
          ]
            .filter(Boolean)
            .join("; "),
        }
      : {}),
  };
};

export type TranscriptNeighborTarget = {
  conversationId: string;
  atMs: number;
};

/** Expand every selected transcript hit with one SQL statement. */
export const listTranscriptNeighborsBatch = (
  db: SqliteDatabase,
  targets: readonly TranscriptNeighborTarget[],
  options?: { before?: number; after?: number; windowMs?: number },
): TranscriptSearchHit[][] => {
  if (targets.length === 0) return [];
  const before = Math.max(0, Math.min(8, Math.floor(options?.before ?? 2)));
  const after = Math.max(0, Math.min(10, Math.floor(options?.after ?? 2)));
  const windowMs = Math.max(60_000, options?.windowMs ?? 2 * 60 * 60 * 1000);
  const values = targets.map(() => "(?, ?, ?)").join(", ");
  const params = targets.flatMap((target, index) => [
    index,
    target.conversationId,
    target.atMs,
  ]);
  type Row = {
    targetIndex: number;
    conversationId: string;
    role: string;
    atMs: number;
    text: unknown;
  };
  const rows = db
    .prepare(
      `WITH targets(target_index, conversation_id, target_ms) AS (
         VALUES ${values}
       ), ranked AS (
         SELECT
           targets.target_index AS targetIndex,
           message.session_id AS conversationId,
           message.role AS role,
           message.created_at AS atMs,
           substr(json_extract(part.data_json, '$.text'), 1, ${TRANSCRIPT_TEXT_CAP}) AS text,
           CASE WHEN message.created_at < targets.target_ms THEN 'before' ELSE 'after' END AS side,
           ROW_NUMBER() OVER (
             PARTITION BY targets.target_index,
               CASE WHEN message.created_at < targets.target_ms THEN 'before' ELSE 'after' END
             ORDER BY ABS(message.created_at - targets.target_ms) ASC
           ) AS distanceRank
         FROM targets
         JOIN message ON message.session_id = targets.conversation_id
         JOIN part ON part.message_id = message.id
         WHERE message.role IN ('user', 'assistant')
           AND message.type IN ('user_message', 'assistant_message')
           AND json_extract(part.data_json, '$.text') IS NOT NULL
           AND message.created_at != targets.target_ms
           AND message.created_at BETWEEN targets.target_ms - ? AND targets.target_ms + ?
       )
       SELECT targetIndex, conversationId, role, atMs, text
       FROM ranked
       WHERE (side = 'before' AND distanceRank <= ?)
          OR (side = 'after' AND distanceRank <= ?)
       ORDER BY targetIndex ASC, atMs ASC`,
    )
    .all(...params, windowMs, windowMs, before, after) as Row[];
  const grouped = targets.map(() => [] as TranscriptSearchHit[]);
  for (const row of rows) {
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text || !grouped[row.targetIndex]) continue;
    grouped[row.targetIndex].push({
      conversationId: row.conversationId,
      role: row.role === "assistant" ? "assistant" : "user",
      atMs: row.atMs,
      text,
    });
  }
  return grouped;
};
