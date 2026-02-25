/**
 * Run Journal — SQLite-based crash-safe journal for the local agent runtime.
 *
 * Uses better-sqlite3 (synchronous) in WAL mode so writes survive process
 * crashes without explicit flush calls. The database lives at
 * `<stellaHome>/state/run_journal.db`.
 */

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import path from "path";
import fs from "fs";

// ---------------------------------------------------------------------------
// Truncation limits
// ---------------------------------------------------------------------------

const MAX_ARGS_JSON_LENGTH = 5_000;
const MAX_RESULT_TEXT_LENGTH = 30_000;

const truncate = (value: string | undefined, limit: number): string | undefined => {
  if (value === undefined) return undefined;
  return value.length > limit ? value.slice(0, limit) : value;
};

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  task_id TEXT,
  agent_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_checkpoint_at INTEGER,
  persist_status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  tool_call_id TEXT,
  tool_name TEXT,
  args_json TEXT,
  result_text TEXT,
  error_text TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE IF NOT EXISTS pending_persist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  persisted INTEGER DEFAULT 0
);
`;

// ---------------------------------------------------------------------------
// RunJournal
// ---------------------------------------------------------------------------

export class RunJournal {
  private db: BetterSqlite3.Database;

  // Prepared statements for hot paths
  private stmtInsertEvent: BetterSqlite3.Statement;
  private stmtInsertPendingPersist: BetterSqlite3.Statement;

  constructor(stellaHome: string) {
    const stateDir = path.join(stellaHome, "state");

    // Ensure the state directory exists (sync — constructor is blocking)
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    const dbPath = path.join(stateDir, "run_journal.db");
    this.db = new Database(dbPath);

    // Enable WAL mode for crash safety and concurrent readers
    this.db.pragma("journal_mode = WAL");

    // Create tables if they don't exist
    this.db.exec(SCHEMA_SQL);

    // Prepare hot-path statements once
    this.stmtInsertEvent = this.db.prepare(`
      INSERT INTO run_events (run_id, seq, type, tool_call_id, tool_name, args_json, result_text, error_text, duration_ms, created_at)
      VALUES (@runId, @seq, @type, @toolCallId, @toolName, @argsJson, @resultText, @errorText, @durationMs, @createdAt)
    `);

    this.stmtInsertPendingPersist = this.db.prepare(`
      INSERT INTO pending_persist (run_id, chunk_index, chunk_key, payload_json)
      VALUES (@runId, @chunkIndex, @chunkKey, @payloadJson)
    `);
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  startRun(opts: {
    runId: string;
    conversationId: string;
    taskId?: string;
    agentType: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, conversation_id, task_id, agent_type, status, started_at, persist_status)
         VALUES (@runId, @conversationId, @taskId, @agentType, 'running', @startedAt, 'pending')`,
      )
      .run({
        runId: opts.runId,
        conversationId: opts.conversationId,
        taskId: opts.taskId ?? null,
        agentType: opts.agentType,
        startedAt: Date.now(),
      });
  }

  completeRun(runId: string): void {
    this.db
      .prepare(
        `UPDATE runs SET status = 'completed', completed_at = @now WHERE run_id = @runId`,
      )
      .run({ runId, now: Date.now() });
  }

  markRunCrashed(runId: string): void {
    this.db
      .prepare(`UPDATE runs SET status = 'crashed' WHERE run_id = @runId`)
      .run({ runId });
  }

  checkpoint(runId: string): void {
    this.db
      .prepare(
        `UPDATE runs SET last_checkpoint_at = @now WHERE run_id = @runId`,
      )
      .run({ runId, now: Date.now() });
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  recordEvent(opts: {
    runId: string;
    seq: number;
    type: string;
    toolCallId?: string;
    toolName?: string;
    argsJson?: string;
    resultText?: string;
    errorText?: string;
    durationMs?: number;
  }): void {
    this.stmtInsertEvent.run({
      runId: opts.runId,
      seq: opts.seq,
      type: opts.type,
      toolCallId: opts.toolCallId ?? null,
      toolName: opts.toolName ?? null,
      argsJson: truncate(opts.argsJson, MAX_ARGS_JSON_LENGTH) ?? null,
      resultText: truncate(opts.resultText, MAX_RESULT_TEXT_LENGTH) ?? null,
      errorText: opts.errorText ?? null,
      durationMs: opts.durationMs ?? null,
      createdAt: Date.now(),
    });
  }

  getRunEvents(
    runId: string,
    afterSeq?: number,
  ): Array<{
    seq: number;
    type: string;
    toolCallId?: string;
    toolName?: string;
    argsJson?: string;
    resultText?: string;
    errorText?: string;
    durationMs?: number;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(
        afterSeq !== undefined
          ? `SELECT seq, type, tool_call_id, tool_name, args_json, result_text, error_text, duration_ms, created_at
             FROM run_events WHERE run_id = @runId AND seq > @afterSeq ORDER BY seq`
          : `SELECT seq, type, tool_call_id, tool_name, args_json, result_text, error_text, duration_ms, created_at
             FROM run_events WHERE run_id = @runId ORDER BY seq`,
      )
      .all(
        afterSeq !== undefined ? { runId, afterSeq } : { runId },
      ) as Array<{
      seq: number;
      type: string;
      tool_call_id: string | null;
      tool_name: string | null;
      args_json: string | null;
      result_text: string | null;
      error_text: string | null;
      duration_ms: number | null;
      created_at: number;
    }>;

    return rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      ...(r.tool_call_id != null ? { toolCallId: r.tool_call_id } : {}),
      ...(r.tool_name != null ? { toolName: r.tool_name } : {}),
      ...(r.args_json != null ? { argsJson: r.args_json } : {}),
      ...(r.result_text != null ? { resultText: r.result_text } : {}),
      ...(r.error_text != null ? { errorText: r.error_text } : {}),
      ...(r.duration_ms != null ? { durationMs: r.duration_ms } : {}),
      createdAt: r.created_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Persist queue
  // -------------------------------------------------------------------------

  addPendingPersist(opts: {
    runId: string;
    chunkIndex: number;
    chunkKey: string;
    payloadJson: string;
  }): void {
    this.stmtInsertPendingPersist.run({
      runId: opts.runId,
      chunkIndex: opts.chunkIndex,
      chunkKey: opts.chunkKey,
      payloadJson: opts.payloadJson,
    });
  }

  markPersisted(chunkKey: string): void {
    this.db
      .prepare(`UPDATE pending_persist SET persisted = 1 WHERE chunk_key = @chunkKey`)
      .run({ chunkKey });
  }

  getUnpersistedChunks(
    runId: string,
  ): Array<{ chunkIndex: number; chunkKey: string; payloadJson: string }> {
    const rows = this.db
      .prepare(
        `SELECT chunk_index, chunk_key, payload_json
         FROM pending_persist
         WHERE run_id = @runId AND persisted = 0
         ORDER BY chunk_index`,
      )
      .all({ runId }) as Array<{
      chunk_index: number;
      chunk_key: string;
      payload_json: string;
    }>;

    return rows.map((r) => ({
      chunkIndex: r.chunk_index,
      chunkKey: r.chunk_key,
      payloadJson: r.payload_json,
    }));
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  recoverCrashedRuns(): Array<{
    runId: string;
    conversationId: string;
    agentType: string;
    status: string;
    persistStatus: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT run_id, conversation_id, agent_type, status, persist_status
         FROM runs
         WHERE status = 'running' OR (status = 'completed' AND persist_status = 'pending')
         ORDER BY started_at`,
      )
      .all() as Array<{
      run_id: string;
      conversation_id: string;
      agent_type: string;
      status: string;
      persist_status: string;
    }>;

    return rows.map((r) => ({
      runId: r.run_id,
      conversationId: r.conversation_id,
      agentType: r.agent_type,
      status: r.status,
      persistStatus: r.persist_status,
    }));
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
