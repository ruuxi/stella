import path from "path";
import type { SqliteDatabase } from "./shared.js";
import { ensurePrivateDirSync } from "../shared/private-fs.js";

const DB_FILE = "stella.sqlite";

export const ensureDatabaseStateRoot = (stellaDataDir: string) => {
  const stateRoot = stellaDataDir;
  ensurePrivateDirSync(stateRoot);
  return stateRoot;
};

export const getDesktopDatabasePath = (stellaDataDir: string) =>
  path.join(ensureDatabaseStateRoot(stellaDataDir), DB_FILE);

/**
 * Full-text index over what was actually SAID in chat — the FTS5 shadow of
 * the `part` rows whose message is a user/assistant `user_message` /
 * `assistant_message` and whose payload carries `$.text`. `searchTranscripts`
 * was previously a full-table scan running `json_extract(...) LIKE '%…%'`
 * per row per token, so every recall lookup got slower as history grew; the
 * FTS table makes it an index lookup with the extraction done once, at
 * write time.
 *
 * Shape notes:
 * - The FTS rowid IS the `part` rowid. UNINDEXED columns are not queryable
 *   efficiently, so the sync triggers delete by rowid — the one key FTS5
 *   resolves without a scan.
 * - Sync is trigger-based (insert/update/delete on `part`) so EVERY writer
 *   is covered — appendEvent's delete-then-reinsert part rewrites, the
 *   third-party importers, and cascading deletes (SQLite fires child-table
 *   delete triggers for ON DELETE CASCADE), which is what keeps deleted
 *   conversations from lingering in search.
 * - `porter unicode61` stems index and query terms alike, replacing the one
 *   thing the LIKE scan did better (substring matches: "drive" ~ "drives").
 * - Backfill is one-time, guarded by a settings flag, and transactional; a
 *   failed backfill drops the whole index so search degrades to the LIKE
 *   scan instead of silently missing older history. An SQLite build without
 *   FTS5 takes the same degradation path.
 */
const TRANSCRIPT_FTS_BACKFILL_FLAG = "transcript_fts_backfilled_v1";

const TRANSCRIPT_FTS_ELIGIBLE_MESSAGE = `
  message.role IN ('user', 'assistant')
  AND message.type IN ('user_message', 'assistant_message')
`;

const dropTranscriptSearchIndex = (db: SqliteDatabase) => {
  db.exec("DROP TRIGGER IF EXISTS trg_message_text_fts_part_insert;");
  db.exec("DROP TRIGGER IF EXISTS trg_message_text_fts_part_update;");
  db.exec("DROP TRIGGER IF EXISTS trg_message_text_fts_part_delete;");
  db.exec("DROP TABLE IF EXISTS message_text_fts;");
};

const ensureTranscriptSearchIndex = (db: SqliteDatabase) => {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS message_text_fts USING fts5(
        text,
        session_id UNINDEXED,
        role UNINDEXED,
        created_at UNINDEXED,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `);
  } catch {
    // This SQLite build lacks FTS5 — searchTranscripts falls back to the
    // LIKE scan. Nothing else to set up.
    return;
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_message_text_fts_part_insert
    AFTER INSERT ON part
    WHEN json_extract(NEW.data_json, '$.text') IS NOT NULL
    BEGIN
      INSERT INTO message_text_fts(rowid, text, session_id, role, created_at)
      SELECT
        NEW.rowid,
        json_extract(NEW.data_json, '$.text'),
        message.session_id,
        message.role,
        message.created_at
      FROM message
      WHERE message.id = NEW.message_id
        AND ${TRANSCRIPT_FTS_ELIGIBLE_MESSAGE};
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_message_text_fts_part_update
    AFTER UPDATE OF data_json ON part
    BEGIN
      DELETE FROM message_text_fts WHERE rowid = OLD.rowid;
      INSERT INTO message_text_fts(rowid, text, session_id, role, created_at)
      SELECT
        NEW.rowid,
        json_extract(NEW.data_json, '$.text'),
        message.session_id,
        message.role,
        message.created_at
      FROM message
      WHERE message.id = NEW.message_id
        AND json_extract(NEW.data_json, '$.text') IS NOT NULL
        AND ${TRANSCRIPT_FTS_ELIGIBLE_MESSAGE};
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_message_text_fts_part_delete
    AFTER DELETE ON part
    BEGIN
      DELETE FROM message_text_fts WHERE rowid = OLD.rowid;
    END;
  `);

  const backfilled = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(TRANSCRIPT_FTS_BACKFILL_FLAG);
  if (backfilled) return;
  try {
    db.exec("BEGIN IMMEDIATE;");
    // An unset flag with rows present means a previous backfill died midway
    // (or predates the flag) — wipe and redo rather than trust a partial
    // index.
    db.exec("DELETE FROM message_text_fts;");
    db.exec(`
      INSERT INTO message_text_fts(rowid, text, session_id, role, created_at)
      SELECT
        part.rowid,
        json_extract(part.data_json, '$.text'),
        message.session_id,
        message.role,
        message.created_at
      FROM part
      JOIN message ON message.id = part.message_id
      WHERE json_extract(part.data_json, '$.text') IS NOT NULL
        AND ${TRANSCRIPT_FTS_ELIGIBLE_MESSAGE};
    `);
    db.prepare(
      `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
    `,
    ).run(TRANSCRIPT_FTS_BACKFILL_FLAG, Date.now());
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Not in a transaction — BEGIN itself failed.
    }
    // A half-built index silently loses older history; no index degrades
    // loudly to the LIKE scan and retries the backfill on the next init.
    dropTranscriptSearchIndex(db);
    throw error instanceof Error
      ? new TranscriptFtsBackfillError(error)
      : error;
  }
};

/**
 * Wraps a backfill failure so callers can tell it apart from init failures
 * that must abort startup: the transcript index is an optimization, so
 * `initializeDesktopDatabase` catches this and continues without it.
 */
class TranscriptFtsBackfillError extends Error {
  constructor(cause: Error) {
    super(`Transcript FTS backfill failed: ${cause.message}`);
    this.name = "TranscriptFtsBackfillError";
  }
}

/**
 * Full-text index over delegated agent threads — the FTS5 shadow behind
 * `searchThreads`. The LIKE scan it replaces could only see thread metadata
 * plus the agent's `description`; this index also carries the agent's final
 * `result`/`error` text, which is the only durable record of what a finished
 * thread actually did (`summary` is empty on nearly every real thread) and
 * was previously unreachable by any keyword search.
 *
 * Shape notes:
 * - The FTS rowid IS the `runtime_threads` rowid, so the sync triggers
 *   delete by rowid — the one key FTS5 resolves without a scan.
 * - MATCHING only, never ordering or payload: no volatile columns
 *   (last_used_at, status) live here, or every progress heartbeat would
 *   rewrite index rows. `searchThreads` resolves the FTS candidates back
 *   through the base tables for ordering and record fields.
 * - The `UPDATE OF` column lists on the triggers are the other half of that
 *   guarantee: `touchThread`-style heartbeats (`runtime_threads.last_used_at`)
 *   and status flips never fire them.
 * - `thread_key` is indexed because models search by id fragments
 *   ("connector-discovery"); unicode61 splits the key into those fragments.
 * - Eligibility mirrors `searchThreads`' WHERE clause and is enforced at
 *   write time, so orchestrator threads and implicit `::subagent::`
 *   transcript rows never enter the index at all.
 * - Backfill, degradation, and drop-on-failure follow the transcript index
 *   above: no FTS5 → skip; failed backfill → drop the whole index and fall
 *   back to the LIKE scan.
 */
const THREAD_FTS_BACKFILL_FLAG = "thread_search_fts_backfilled_v2";

const THREAD_FTS_ELIGIBLE = `
  runtime_threads.agent_type != 'orchestrator'
  AND runtime_threads.thread_key NOT LIKE '%::subagent::%'
`;

const dropThreadSearchIndex = (db: SqliteDatabase) => {
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_thread_insert;");
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_thread_update;");
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_thread_delete;");
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_agent_insert;");
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_agent_update;");
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_agent_delete;");
  db.exec("DROP TABLE IF EXISTS thread_search_fts;");
};

const ensureThreadSearchIndex = (db: SqliteDatabase) => {
  const existingColumns = db
    .prepare("PRAGMA table_info(thread_search_fts)")
    .all() as Array<{ name?: string }>;
  if (
    existingColumns.some(
      (column) => column.name === "group_key" || column.name === "group_label",
    )
  ) {
    dropThreadSearchIndex(db);
  }
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS thread_search_fts USING fts5(
        thread_key,
        name,
        summary,
        description,
        result,
        error,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `);
  } catch {
    // This SQLite build lacks FTS5 — searchThreads falls back to the LIKE
    // scan. Nothing else to set up.
    return;
  }

  // The leading DELETE makes the insert idempotent per rowid: INSERT OR
  // REPLACE on the base table would bypass the delete trigger and leave a
  // stale FTS row behind. No current writer uses OR REPLACE, but the guard
  // is one indexed delete and immunizes against future ones.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_thread_insert
    AFTER INSERT ON runtime_threads
    WHEN NEW.agent_type != 'orchestrator'
      AND NEW.thread_key NOT LIKE '%::subagent::%'
    BEGIN
      DELETE FROM thread_search_fts WHERE rowid = NEW.rowid;
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      VALUES (
        NEW.rowid, NEW.thread_key, NEW.name, NEW.summary,
        (SELECT description FROM runtime_agents WHERE thread_id = NEW.thread_key),
        (SELECT result FROM runtime_agents WHERE thread_id = NEW.thread_key),
        (SELECT error FROM runtime_agents WHERE thread_id = NEW.thread_key)
      );
    END;
  `);
  // Only the searchable columns are listed: last_used_at churns on every
  // heartbeat and status flips on evict/reactivate, and neither may rewrite
  // index rows. agent_type/thread_key are immutable in practice, so
  // eligibility can't change under an existing row.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_thread_update
    AFTER UPDATE OF name, summary ON runtime_threads
    WHEN NEW.agent_type != 'orchestrator'
      AND NEW.thread_key NOT LIKE '%::subagent::%'
    BEGIN
      DELETE FROM thread_search_fts WHERE rowid = OLD.rowid;
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      VALUES (
        NEW.rowid, NEW.thread_key, NEW.name, NEW.summary,
        (SELECT description FROM runtime_agents WHERE thread_id = NEW.thread_key),
        (SELECT result FROM runtime_agents WHERE thread_id = NEW.thread_key),
        (SELECT error FROM runtime_agents WHERE thread_id = NEW.thread_key)
      );
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_thread_delete
    AFTER DELETE ON runtime_threads
    BEGIN
      DELETE FROM thread_search_fts WHERE rowid = OLD.rowid;
    END;
  `);

  // Agent writes rebuild the OWNING THREAD's row: the FTS rowid is the
  // thread's, and `saveAgentRecord` upserts can land before the thread row
  // exists — the INSERT..SELECT join then inserts nothing, and the later
  // thread insert picks the agent columns up via its subqueries.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_agent_insert
    AFTER INSERT ON runtime_agents
    BEGIN
      DELETE FROM thread_search_fts
      WHERE rowid = (
        SELECT rowid FROM runtime_threads WHERE thread_key = NEW.thread_id
      );
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        NEW.description, NEW.result, NEW.error
      FROM runtime_threads
      WHERE runtime_threads.thread_key = NEW.thread_id
        AND ${THREAD_FTS_ELIGIBLE};
    END;
  `);
  // status/updated_at churn on every agent heartbeat and are deliberately
  // absent from this UPDATE OF list. The WHEN clause closes the remaining
  // hole: saveAgentRecord's upsert SETs every column, and UPDATE OF fires on
  // SET-list MEMBERSHIP, not value change — without it every agent save
  // rebuilt the FTS row. IS NOT is the null-safe inequality.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_agent_update
    AFTER UPDATE OF description, result, error ON runtime_agents
    WHEN NEW.description IS NOT OLD.description
      OR NEW.result IS NOT OLD.result
      OR NEW.error IS NOT OLD.error
    BEGIN
      DELETE FROM thread_search_fts
      WHERE rowid = (
        SELECT rowid FROM runtime_threads WHERE thread_key = NEW.thread_id
      );
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        NEW.description, NEW.result, NEW.error
      FROM runtime_threads
      WHERE runtime_threads.thread_key = NEW.thread_id
        AND ${THREAD_FTS_ELIGIBLE};
    END;
  `);
  // The thread row can outlive its agent record, so a deleted agent strips
  // the agent columns from the thread's row rather than dropping it.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_agent_delete
    AFTER DELETE ON runtime_agents
    BEGIN
      DELETE FROM thread_search_fts
      WHERE rowid = (
        SELECT rowid FROM runtime_threads WHERE thread_key = OLD.thread_id
      );
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        NULL, NULL, NULL
      FROM runtime_threads
      WHERE runtime_threads.thread_key = OLD.thread_id
        AND ${THREAD_FTS_ELIGIBLE};
    END;
  `);

  const backfilled = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(THREAD_FTS_BACKFILL_FLAG);
  if (backfilled) return;
  try {
    db.exec("BEGIN IMMEDIATE;");
    // An unset flag with rows present means a previous backfill died midway
    // (or predates the flag) — wipe and redo rather than trust a partial
    // index.
    db.exec("DELETE FROM thread_search_fts;");
    db.exec(`
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        runtime_agents.description, runtime_agents.result,
        runtime_agents.error
      FROM runtime_threads
      LEFT JOIN runtime_agents
        ON runtime_agents.thread_id = runtime_threads.thread_key
      WHERE ${THREAD_FTS_ELIGIBLE};
    `);
    db.prepare(
      `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
    `,
    ).run(THREAD_FTS_BACKFILL_FLAG, Date.now());
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Not in a transaction — BEGIN itself failed.
    }
    // A half-built index silently loses older threads; no index degrades
    // loudly to the LIKE scan and retries the backfill on the next init.
    dropThreadSearchIndex(db);
    throw error instanceof Error ? new ThreadFtsBackfillError(error) : error;
  }
};

/**
 * Same contract as `TranscriptFtsBackfillError`: the thread index is an
 * optimization, so `initializeDesktopDatabase` catches this and continues
 * without it.
 */
class ThreadFtsBackfillError extends Error {
  constructor(cause: Error) {
    super(`Thread FTS backfill failed: ${cause.message}`);
    this.name = "ThreadFtsBackfillError";
  }
}

const SELF_MOD_PENDING_CHANGE_SETS_TABLE = "self_mod_pending_change_sets";
const SELF_MOD_PENDING_CHANGE_SETS_LEGACY_TABLE =
  "self_mod_pending_change_sets_legacy_v1";

const CURRENT_SELF_MOD_PENDING_CHANGE_SETS_SQL = `
  CREATE TABLE IF NOT EXISTS self_mod_pending_change_sets (
    change_set_id TEXT PRIMARY KEY,
    repo_root TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    owner_thread_id TEXT NOT NULL,
    completion_event_id TEXT NOT NULL,
    assistant_message_event_id TEXT,
    commit_hashes_json TEXT,
    status TEXT NOT NULL CHECK (
      status IN ('published', 'attached', 'applying', 'applied')
    ),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(repo_root, completion_event_id)
  );
`;

type SqliteTableInfoRow = { name: string };

const sqliteTableColumns = (
  db: SqliteDatabase,
  tableName: string,
): Set<string> =>
  new Set(
    (
      db
        .prepare(`PRAGMA table_info(${tableName});`)
        .all() as SqliteTableInfoRow[]
    ).map((row) => row.name),
  );

/**
 * A reverted self-mod implementation used this table name for an incompatible
 * payload_json ledger. SQLite keeps removed-feature tables forever, so
 * CREATE TABLE IF NOT EXISTS cannot upgrade those installations to the
 * current grouped-Apply schema. Preserve the obsolete payloads in a stable
 * archive and replace the source table atomically before worker startup reads
 * the new columns.
 */
const migrateLegacySelfModPendingChangeSets = (db: SqliteDatabase): void => {
  const sourceColumns = sqliteTableColumns(
    db,
    SELF_MOD_PENDING_CHANGE_SETS_TABLE,
  );
  if (sourceColumns.size === 0 || !sourceColumns.has("payload_json")) return;

  const requiredLegacyColumns = [
    "change_set_id",
    "repo_root",
    "payload_json",
    "created_at",
    "updated_at",
  ];
  const supportedLegacyColumns = new Set([
    ...requiredLegacyColumns,
    "commit_hashes_json",
  ]);
  if (
    requiredLegacyColumns.some((column) => !sourceColumns.has(column)) ||
    [...sourceColumns].some((column) => !supportedLegacyColumns.has(column))
  ) {
    throw new Error(
      "Cannot losslessly archive an unknown self_mod_pending_change_sets schema.",
    );
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    // Hold the write lock while checking this fence. Otherwise another worker
    // could stage a current contribution after the check but before the old
    // parent table is replaced.
    const contributionColumns = sqliteTableColumns(
      db,
      "self_mod_pending_contributions",
    );
    if (contributionColumns.size > 0) {
      const contribution = db
        .prepare("SELECT 1 FROM self_mod_pending_contributions LIMIT 1;")
        .get();
      if (contribution) {
        throw new Error(
          "Cannot migrate the legacy self-mod change-set table while current pending contributions exist.",
        );
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${SELF_MOD_PENDING_CHANGE_SETS_LEGACY_TABLE} (
        change_set_id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        commit_hashes_json TEXT
      );
    `);
    const archiveColumns = sqliteTableColumns(
      db,
      SELF_MOD_PENDING_CHANGE_SETS_LEGACY_TABLE,
    );
    if (
      requiredLegacyColumns.some((column) => !archiveColumns.has(column)) ||
      [...archiveColumns].some((column) => !supportedLegacyColumns.has(column))
    ) {
      throw new Error(
        "Cannot merge the legacy self-mod change-set archive because its schema is incompatible.",
      );
    }
    if (!archiveColumns.has("commit_hashes_json")) {
      db.exec(`
        ALTER TABLE ${SELF_MOD_PENDING_CHANGE_SETS_LEGACY_TABLE}
        ADD COLUMN commit_hashes_json TEXT;
      `);
    }

    const sourceCommitHashes = sourceColumns.has("commit_hashes_json")
      ? "commit_hashes_json"
      : "NULL";
    db.exec(`
      INSERT INTO ${SELF_MOD_PENDING_CHANGE_SETS_LEGACY_TABLE} (
        change_set_id,
        repo_root,
        payload_json,
        created_at,
        updated_at,
        commit_hashes_json
      )
      SELECT
        change_set_id,
        repo_root,
        payload_json,
        created_at,
        updated_at,
        ${sourceCommitHashes}
      FROM ${SELF_MOD_PENDING_CHANGE_SETS_TABLE}
      WHERE true
      ON CONFLICT(change_set_id) DO UPDATE SET
        repo_root = excluded.repo_root,
        payload_json = excluded.payload_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        commit_hashes_json = excluded.commit_hashes_json
      WHERE excluded.updated_at >
        ${SELF_MOD_PENDING_CHANGE_SETS_LEGACY_TABLE}.updated_at;
    `);

    db.exec(`DROP TABLE ${SELF_MOD_PENDING_CHANGE_SETS_TABLE};`);
    db.exec(CURRENT_SELF_MOD_PENDING_CHANGE_SETS_SQL);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_self_mod_pending_change_sets_legacy_v1_repo_created
      ON ${SELF_MOD_PENDING_CHANGE_SETS_LEGACY_TABLE}(repo_root, created_at);
    `);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
};

export const initializeDesktopDatabase = (db: SqliteDatabase) => {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec("PRAGMA busy_timeout = 5000;");
  // Per-connection in SQLite (OFF by default) — without it every ON DELETE
  // CASCADE declared below is inert. Every connection funnels through this
  // initializer, and no writer uses INSERT OR REPLACE on a parent table, so
  // enforcement cannot trigger a surprise delete-then-cascade.
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      parent_id TEXT,
      workspace_path TEXT,
      sync_checkpoint_message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      thread_key TEXT,
      run_id TEXT,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      request_id TEXT,
      device_id TEXT,
      target_device_id TEXT,
      agent_type TEXT,
      data_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_session_created
    ON message(session_id, created_at, id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_thread_created
    ON message(thread_key, created_at, id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_run_created
    ON message(run_id, created_at, id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ord INTEGER NOT NULL,
      type TEXT NOT NULL,
      tool_call_id TEXT,
      data_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE,
      FOREIGN KEY(message_id) REFERENCES message(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_part_message_ord
    ON part(message_id, ord);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_part_session_created
    ON part(session_id, created_at, id);
  `);

  try {
    ensureTranscriptSearchIndex(db);
  } catch (error) {
    // The transcript index is an optimization — a failed backfill (e.g. a
    // malformed legacy row) must not brick startup. The index was dropped,
    // so search degrades to the LIKE scan.
    if (!(error instanceof TranscriptFtsBackfillError)) throw error;
  }

  db.exec("DROP TABLE IF EXISTS chat_sync_checkpoints;");
  db.exec("DROP TABLE IF EXISTS chat_events;");
  db.exec("DROP TABLE IF EXISTS chat_conversations;");
  db.exec("DROP TABLE IF EXISTS runtime_thread_messages;");
  db.exec("DROP TABLE IF EXISTS runtime_run_events;");
  db.exec("DROP TABLE IF EXISTS runtime_memories;");
  db.exec("DROP TABLE IF EXISTS runtime_tasks;");
  db.exec("DROP TABLE IF EXISTS self_mod_batches;");
  db.exec("DROP TABLE IF EXISTS self_mod_features;");

  // Worker-side ring buffer of streamed run events. Each row represents one
  // notification the worker sent to a connected client over JSON-RPC. The
  // client (Electron host) subscribes via NOTIFICATION_NAMES.RUN_EVENT and
  // is expected to ack with run.ackEvents { runId, lastSeq } so the worker
  // can prune. On host reconnect (for example, after Electron restart) the
  // new client calls run.resumeEvents { runId, lastSeq }
  // to replay everything past `lastSeq`. The fallback retention is the
  // periodic time-based sweep below — acks are an optimization, not a
  // correctness requirement.
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_event_log (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_run_event_log_created
    ON run_event_log(created_at);
  `);
  // Old install ledger that tracked apply-commit hashes per package.
  // Replaced by `store_installs` (one row per installed package, single
  // commit hash captured from the blueprint-implementing general-agent run).
  db.exec("DROP TABLE IF EXISTS store_mod_installs;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_threads (
      thread_key TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      summary TEXT,
      external_session_id TEXT,
      external_delivered_entry_id TEXT
    );
  `);
  try {
    db.exec("ALTER TABLE runtime_threads ADD COLUMN external_session_id TEXT;");
  } catch {
    // Column already exists.
  }
  try {
    db.exec(
      "ALTER TABLE runtime_threads ADD COLUMN external_delivered_entry_id TEXT;",
    );
  } catch {
    // Column already exists.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_conversation_status
    ON runtime_threads(conversation_id, status, last_used_at);
  `);
  db.exec("DROP INDEX IF EXISTS idx_runtime_threads_group;");
  // Recall's thread index selects "most recent N by last-active" across ALL
  // conversations; these global recency indexes let that query walk two
  // index scans instead of full-scanning + temp-sorting the tables.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_last_used
    ON runtime_threads(last_used_at);
  `);
  // Recall's adaptive-limit preflight counts threads created in the last
  // day on every call; this recency index keeps that COUNT a range scan
  // instead of a full-table scan over all history.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_created
    ON runtime_threads(created_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_thread_sessions (
      thread_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      cwd TEXT NOT NULL DEFAULT '',
      parent_session TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(thread_key) REFERENCES runtime_threads(thread_key) ON DELETE CASCADE
    );
  `);

  // Keep the column backfill and trigger installation under one writer lock.
  // Without it, an already-running process can insert NULL rows after the
  // backfill but before the trigger exists, leaving a partially migrated DB.
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_thread_entries (
        entry_id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_entry_id TEXT,
        entry_type TEXT NOT NULL,
        timestamp_iso TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        insertion_sequence INTEGER,
        data_json TEXT,
        FOREIGN KEY(thread_key) REFERENCES runtime_threads(thread_key) ON DELETE CASCADE
      );
    `);
    try {
      db.exec(
        "ALTER TABLE runtime_thread_entries ADD COLUMN insertion_sequence INTEGER;",
      );
    } catch {
      // Column already exists.
    }
    db.exec("DROP INDEX IF EXISTS idx_runtime_thread_entries_thread_append;");
    // Timestamp-prefixed entry ids have a random suffix, so neither
    // `(created_at, entry_id)` nor the timestamp alone records append order.
    // Preserve the current SQLite insertion order for legacy rows once, then
    // assign a durable ordinal to every future row. If an older migration was
    // interrupted between its backfill and trigger creation, re-rank the whole
    // table so its NULL rows regain their real positions without colliding with
    // sequence values that later inserts already claimed.
    const needsInsertionSequenceRepair = db
      .prepare(
        `SELECT 1
         FROM runtime_thread_entries
         WHERE insertion_sequence IS NULL
         LIMIT 1`,
      )
      .get();
    if (needsInsertionSequenceRepair) {
      db.exec("DROP INDEX IF EXISTS idx_runtime_thread_entries_sequence;");
      db.exec(`
        WITH ranked_entries AS (
          SELECT
            rowid AS entry_rowid,
            ROW_NUMBER() OVER (ORDER BY rowid) AS insertion_sequence
          FROM runtime_thread_entries
        )
        UPDATE runtime_thread_entries
        SET insertion_sequence = (
          SELECT ranked_entries.insertion_sequence
          FROM ranked_entries
          WHERE ranked_entries.entry_rowid = runtime_thread_entries.rowid
        );
      `);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_thread_entries_sequence
      ON runtime_thread_entries(insertion_sequence)
      WHERE insertion_sequence IS NOT NULL;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_runtime_thread_entries_sequence
      AFTER INSERT ON runtime_thread_entries
      WHEN NEW.insertion_sequence IS NULL
      BEGIN
        UPDATE runtime_thread_entries
        SET insertion_sequence = (
          SELECT COALESCE(MAX(insertion_sequence), 0) + 1
          FROM runtime_thread_entries
        )
        WHERE rowid = NEW.rowid;
      END;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_thread_entries_thread_created
      ON runtime_thread_entries(thread_key, created_at, entry_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_thread_entries_thread_sequence
      ON runtime_thread_entries(thread_key, insertion_sequence);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_thread_entries_thread_parent
      ON runtime_thread_entries(thread_key, parent_entry_id, created_at, entry_id);
    `);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_agents (
      thread_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      description TEXT NOT NULL,
      agent_depth INTEGER NOT NULL,
      max_agent_depth INTEGER,
      parent_agent_id TEXT,
      -- Retired with the Manager agent type. Kept (nullable, never read or
      -- written) so existing databases stay schema-compatible without a
      -- destructive table rebuild.
      manager_turn_state_json TEXT,
      descendant_boundary_state_json TEXT,
      self_mod_metadata_json TEXT,
      model_config_json TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      result TEXT,
      error TEXT,
      updated_at INTEGER NOT NULL,
      root_run_id TEXT,
      attempt_generation INTEGER NOT NULL DEFAULT 0
    );
  `);
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN root_run_id TEXT;");
  } catch {
    // Column already exists.
  }
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN model_config_json TEXT;");
  } catch {
    // Column already exists.
  }
  try {
    db.exec(
      "ALTER TABLE runtime_agents ADD COLUMN manager_turn_state_json TEXT;",
    );
  } catch {
    // Column already exists.
  }
  try {
    db.exec(
      "ALTER TABLE runtime_agents ADD COLUMN descendant_boundary_state_json TEXT;",
    );
  } catch {
    // Column already exists.
  }
  try {
    db.exec(
      "ALTER TABLE runtime_agents ADD COLUMN attempt_generation INTEGER NOT NULL DEFAULT 0;",
    );
  } catch {
    // Column already exists.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_agents_conversation_updated
    ON runtime_agents(conversation_id, updated_at, thread_id);
  `);
  // Second half of the recall-index recency scan (see runtime_threads
  // counterpart above): a running turn bumps only the agent record, so
  // "recently active" candidates also come from agent updated_at order.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_agents_updated
    ON runtime_agents(updated_at);
  `);

  // Passive Claude Code child projections. These deliberately do not share
  // runtime_agents: Claude owns their execution/lifecycle, while Stella only
  // persists enough observation state to render nested Activity and a
  // read-only transcript without creating manager wake/cancel semantics.
  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_native_children (
      thread_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      owner_thread_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      claude_session_id TEXT NOT NULL,
      native_tool_use_id TEXT NOT NULL,
      native_task_id TEXT,
      description TEXT NOT NULL,
      prompt TEXT,
      subagent_type TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      result TEXT,
      error TEXT,
      updated_at INTEGER NOT NULL,
      root_run_id TEXT,
      UNIQUE(owner_thread_id, claude_session_id, native_tool_use_id)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_claude_native_children_conversation
    ON claude_native_children(conversation_id, started_at, thread_id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_claude_native_children_owner_tool
    ON claude_native_children(owner_thread_id, native_tool_use_id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_claude_native_children_owner_task
    ON claude_native_children(owner_thread_id, native_task_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_native_child_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL UNIQUE,
      child_thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(child_thread_id) REFERENCES claude_native_children(thread_id)
        ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_claude_native_child_messages_page
    ON claude_native_child_messages(child_thread_id, sequence DESC);
  `);

  // Must run AFTER runtime_threads and runtime_agents exist — the sync
  // triggers reference both tables.
  try {
    ensureThreadSearchIndex(db);
  } catch (error) {
    // Same degradation contract as the transcript index above: the thread
    // index is an optimization, and searchThreads falls back to its LIKE
    // scan once the failed index is dropped.
    if (!(error instanceof ThreadFtsBackfillError)) throw error;
  }
  // Legacy generated progress-summary rows. Keep the table so existing
  // databases need no destructive migration; current product code neither
  // writes nor reads it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_progress_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_progress_summaries_agent
    ON agent_progress_summaries(agent_id, created_at, id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_conversation_state (
      conversation_id TEXT PRIMARY KEY,
      reminder_tokens_since_last_injection INTEGER NOT NULL DEFAULT 0,
      force_reminder_on_next_turn INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_memory_review_state (
      conversation_id TEXT PRIMARY KEY,
      user_turns_since_review INTEGER NOT NULL DEFAULT 0,
      last_review_at INTEGER,
      last_reviewed_message_ts INTEGER
    );
  `);
  try {
    db.exec(
      "ALTER TABLE runtime_memory_review_state ADD COLUMN last_reviewed_message_ts INTEGER;",
    );
  } catch {
    // Column already exists.
  }

  // Rolling-window snapshot of recent self-mod commits, named by a cheap
  // LLM. Single row, regenerated on every successful self-mod commit. The
  // side panel reads this row to render the "features list" the user
  // selects from when publishing a source-backed Store release.
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_mod_feature_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      items_json TEXT NOT NULL,
      generated_at INTEGER NOT NULL
    );
  `);

  // Durable author-mode HMR ledger. Contributions are written as soon as a
  // run's tracked writes finalize, then assigned to exactly one completion
  // change set when the owning General's terminal result is delivered. The
  // serialized ApplyResult is intentionally retained until the HMR transition
  // succeeds so a worker restart can rehydrate a still-clickable Apply card.
  migrateLegacySelfModPendingChangeSets(db);
  db.exec(CURRENT_SELF_MOD_PENDING_CHANGE_SETS_SQL);
  try {
    db.exec(
      "ALTER TABLE self_mod_pending_change_sets ADD COLUMN assistant_message_event_id TEXT;",
    );
  } catch {
    // Column already exists.
  }
  try {
    db.exec(
      "ALTER TABLE self_mod_pending_change_sets ADD COLUMN commit_hashes_json TEXT;",
    );
  } catch {
    // Column already exists.
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_mod_pending_contributions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      apply_id TEXT NOT NULL,
      repo_root TEXT NOT NULL,
      commit_hash TEXT,
      apply_result_json TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      files_json TEXT NOT NULL,
      owner_thread_id TEXT,
      change_set_id TEXT REFERENCES self_mod_pending_change_sets(change_set_id),
      completion_event_id TEXT,
      assistant_message_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(repo_root, apply_id)
    );
  `);
  try {
    db.exec(
      "ALTER TABLE self_mod_pending_contributions ADD COLUMN assistant_message_event_id TEXT;",
    );
  } catch {
    // Column already exists.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_self_mod_pending_unpublished_owner
    ON self_mod_pending_contributions(
      repo_root,
      conversation_id,
      owner_thread_id,
      change_set_id,
      sequence
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_self_mod_pending_change_set
    ON self_mod_pending_contributions(change_set_id, sequence);
  `);

  // Durable feature roster: one row per self-mod feature, keyed by the
  // Stella-Feature-Id stamped into commit trailers at commit time (the
  // authoring thread's group key, falling back to its thread key).
  // Unlike the rolling snapshot above, rows accrue forever — features
  // never fall off; the Store panel paginates instead. Names are frozen
  // at first commit (write-once) so they never churn.
  // NOTE: `self_mod_features` is a legacy name dropped on every init —
  // do not rename this table to it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_feature_roster (
      feature_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      conversation_id TEXT,
      created_at INTEGER NOT NULL,
      last_commit_at INTEGER NOT NULL,
      commit_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_feature_commits (
      feature_id TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      committed_at INTEGER NOT NULL,
      PRIMARY KEY (feature_id, commit_hash)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_store_feature_roster_last_commit
    ON store_feature_roster(last_commit_at);
  `);

  // Wipe any older shape of this table before recreating it. The first
  // iteration of the revert ledger used a single `consumed_at` watermark;
  // the current schema replaced it with separate orchestrator vs
  // origin-thread consumption slots plus `origin_thread_key`. No
  // production data exists yet, so a hard-cut drop here is morally
  // equivalent to redefining the table — per the workspace rule against
  // migrations, this stays a one-line drop rather than ALTER TABLE.
  db.exec("DROP TABLE IF EXISTS self_mod_reverts;");

  // Ledger of self-mod reverts the user has triggered from the inline
  // "Undo changes" affordance. The revert-notice hook
  // (`runtime/extensions/stella-runtime/hooks/revert-notice.hook.ts`)
  // reads unconsumed rows on `before_user_message`, injects a short
  // hidden system reminder, and flips the appropriate `consumed_by_*`
  // slot so the reminder fires exactly once per agent.
  //
  // Two-slot consumption ladder:
  //   - `consumed_by_orchestrator`: orchestrator's turn slot. Drained
  //     whenever the orchestrator builds a user-turn prompt for this
  //     conversation (`payload.agentType === orchestrator`).
  //   - `consumed_by_origin_thread`: drained when the SPECIFIC agent
  //     that authored the reverted commit (matched by `Stella-Thread`
  //     commit trailer == `payload.threadKey`) builds a user-turn
  //     prompt. Resumable subagents have stable threadKeys
  //     (`buildRuntimeThreadKey` returns the persisted thread id), so
  //     the same general agent the orchestrator later resumes via
  //     `send_input` picks up the notice.
  //
  // `origin_thread_key` is optional: commits authored before the
  // `Stella-Thread` trailer existed (or where threadKey wasn't
  // available at finalize time) get NULL here and rely on
  // orchestrator-only routing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_mod_reverts (
      revert_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      origin_thread_key TEXT,
      commit_hash TEXT NOT NULL,
      files_json TEXT NOT NULL,
      reverted_at INTEGER NOT NULL,
      consumed_by_orchestrator INTEGER NOT NULL DEFAULT 0,
      consumed_by_origin_thread INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_self_mod_reverts_pending_orchestrator
    ON self_mod_reverts(conversation_id, consumed_by_orchestrator, reverted_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_self_mod_reverts_pending_origin_thread
    ON self_mod_reverts(origin_thread_key, consumed_by_origin_thread, reverted_at);
  `);

  // One row per installed Store add-on. The blueprint-driven install
  // flow runs a general agent that implements the blueprint; we capture
  // the self-mod commit hashes here so uninstall can revert installs
  // plus later updates in reverse order.
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_installs (
      package_id TEXT PRIMARY KEY,
      release_number INTEGER NOT NULL,
      install_commit_hash TEXT,
      install_commit_hashes_json TEXT NOT NULL DEFAULT '[]',
      source_revision_id TEXT,
      source_revision_ids_json TEXT NOT NULL DEFAULT '[]',
      installed_at INTEGER NOT NULL
    );
  `);
  try {
    db.exec(`
      ALTER TABLE store_installs
      ADD COLUMN install_commit_hashes_json TEXT NOT NULL DEFAULT '[]';
    `);
  } catch {
    // Column already exists.
  }
  try {
    db.exec(`
      ALTER TABLE store_installs
      ADD COLUMN source_revision_id TEXT;
    `);
  } catch {
    // Column already exists.
  }
  try {
    db.exec(`
      ALTER TABLE store_installs
      ADD COLUMN source_revision_ids_json TEXT NOT NULL DEFAULT '[]';
    `);
  } catch {
    // Column already exists.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_store_installs_installed_at
    ON store_installs(installed_at);
  `);

  // Local Stella source-history graph. The rows store revision identity,
  // parent links, feature/package attribution, and changed-path hashes only.
  // Full source content stays in the working tree or in explicit share packs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS stella_source_revisions (
      revision_id TEXT PRIMARY KEY,
      base_revision_id TEXT NOT NULL,
      parent_revision_ids_json TEXT NOT NULL,
      feature_id TEXT,
      description TEXT,
      origin TEXT NOT NULL,
      commit_hash TEXT UNIQUE,
      package_id TEXT,
      release_number INTEGER,
      change_set_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS stella_source_revision_commits (
      commit_hash TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(revision_id) REFERENCES stella_source_revisions(revision_id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    INSERT OR IGNORE INTO stella_source_revision_commits (
      commit_hash,
      revision_id,
      created_at
    )
    SELECT commit_hash, revision_id, created_at
    FROM stella_source_revisions
    WHERE commit_hash IS NOT NULL AND commit_hash != '';
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stella_source_revisions_commit
    ON stella_source_revisions(commit_hash);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stella_source_revision_commits_revision
    ON stella_source_revision_commits(revision_id, created_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stella_source_revisions_feature_created
    ON stella_source_revisions(feature_id, created_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stella_source_revisions_package_created
    ON stella_source_revisions(package_id, created_at);
  `);

  // Legacy local Store draft thread table. Kept so older local databases open
  // cleanly, but the current Store publish flow selects source changes
  // directly and does not use this thread.
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_thread_messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system_event')),
      text TEXT NOT NULL,
      is_blueprint INTEGER NOT NULL DEFAULT 0,
      denied INTEGER NOT NULL DEFAULT 0,
      published INTEGER NOT NULL DEFAULT 0,
      published_release_number INTEGER,
      pending INTEGER NOT NULL DEFAULT 0,
      attached_feature_names_json TEXT NOT NULL DEFAULT '[]',
      editing_blueprint INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_store_thread_messages_created
    ON store_thread_messages(created_at, id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_session_sync_state (
      session_id TEXT PRIMARY KEY,
      local_folder_path TEXT NOT NULL,
      local_folder_name TEXT NOT NULL,
      role TEXT NOT NULL,
      last_applied_file_op_ordinal INTEGER NOT NULL DEFAULT 0,
      last_observed_turn_ordinal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_session_files (
      session_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, relative_path)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_social_session_files_session
    ON social_session_files(session_id, updated_at);
  `);

  // Unified Dream inbox: every durable input Dream consolidates flows through
  // this one queue — subagent rollout summaries, orchestrator memory-review
  // notes, and chronicle screen-activity digests. `processed_by_dream_at IS
  // NULL` is the entire queue state (the pass-completion watermark below is
  // scheduling bookkeeping, never queue state).
  // Replaces the pre-launch `thread_summaries` table (hard cut, no migration).
  db.exec("DROP TABLE IF EXISTS thread_summaries;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      source_key TEXT NOT NULL,
      thread_id TEXT,
      run_id TEXT,
      agent_type TEXT,
      title TEXT,
      content TEXT NOT NULL,
      metadata TEXT,
      conversation_id TEXT,
      source_updated_at INTEGER NOT NULL,
      processed_by_dream_at INTEGER,
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_usage INTEGER,
      UNIQUE (kind, source_key)
    );
  `);
  // Reporting conversation for a row (subagent rows carry the parent's
  // conversation — the thread whose window holds the byte-equivalent
  // report). The delta-input pass may mechanically consume ONLY rows whose
  // conversation matches its delta; legacy NULL rows always go through the
  // model-driven list/markProcessed path, so scoping can never drop a row
  // the delta never covered.
  try {
    db.exec("ALTER TABLE dream_inbox ADD COLUMN conversation_id TEXT;");
  } catch {
    // Column already exists.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dream_inbox_unprocessed
    ON dream_inbox(processed_by_dream_at, source_updated_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dream_inbox_kind_updated
    ON dream_inbox(kind, source_updated_at);
  `);

  // Persisted marker of the last COMPLETED Dream consolidation pass, keyed by
  // the pending-inbox frontier (max source_updated_at among unprocessed rows)
  // captured when that pass started. It is NOT queue state — per-row
  // `processed_by_dream_at` remains the sole authority on what has been
  // consumed (no double-processing; a row missed once stays queued). The
  // watermark only lets the consolidate-before-compact ordering skip its
  // bounded await when a pass already completed past the current frontier, so
  // losing or lagging it costs freshness (an extra or a skipped best-effort
  // pass), never correctness. Single row; survives restarts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_consolidation_watermark (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      frontier INTEGER NOT NULL,
      completed_at INTEGER NOT NULL
    );
  `);

  // Persisted message-timestamp watermark for Dream's orchestrator-delta
  // input (migration step 6): the newest thread message a completed delta
  // derivation (shadow or live) has covered, per conversation. Message
  // timestamps make it restart-proof and compaction-proof — the same
  // mechanism as runtime_memory_review_state.last_reviewed_message_ts.
  // Monotonic; a lost row costs one re-derivation window, never facts
  // (raw thread entries and the transcript FTS persist regardless).
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_delta_watermark (
      conversation_id TEXT PRIMARY KEY,
      last_message_ts INTEGER NOT NULL,
      applied_through_ts INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
  // Applied (cutover-pass) coverage, distinct from the shared shadow+cutover
  // watermark above: memory_note mechanical consumption requires applied
  // coverage contiguous through the pass's window start, because a note's
  // source span reaches below its own timestamp and shadow-only coverage
  // discarded its proposals. NULL/0 = no cutover pass ever applied.
  try {
    db.exec(
      "ALTER TABLE dream_delta_watermark ADD COLUMN applied_through_ts INTEGER;",
    );
  } catch {
    // Column already exists.
  }

  // Persisted token baseline for the Dream scheduler's token_interval gate.
  // Previously in-memory only: every worker restart reset it to 0, so the
  // first token_interval evaluation measured "growth" from zero and fired a
  // spurious pass (design review §6.1: "fixing the in-memory token-baseline
  // reset"). Single row; purely a scheduling signal.
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_scheduler_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tokens_at_last_run INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
};
