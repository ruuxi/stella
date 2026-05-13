import path from "path";
import type { SqliteDatabase } from "./shared.js";
import { ensurePrivateDirSync } from "../shared/private-fs.js";

const DB_FILE = "stella.sqlite";

export const ensureDatabaseStateRoot = (stellaHome: string) => {
  const stateRoot = path.join(stellaHome, "state");
  ensurePrivateDirSync(stateRoot);
  return stateRoot;
};

export const getDesktopDatabasePath = (stellaHome: string) =>
  path.join(ensureDatabaseStateRoot(stellaHome), DB_FILE);

export const initializeDesktopDatabase = (db: SqliteDatabase) => {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec("PRAGMA busy_timeout = 5000;");

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
  // can prune. On host reconnect (after Electron restart, mini-window
  // open, etc.) the new client calls run.resumeEvents { runId, lastSeq }
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
      external_session_id TEXT
    );
  `);
  try {
    db.exec("ALTER TABLE runtime_threads ADD COLUMN external_session_id TEXT;");
  } catch {
    // Column already exists.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_conversation_status
    ON runtime_threads(conversation_id, status, last_used_at);
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_thread_entries (
      entry_id TEXT PRIMARY KEY,
      thread_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_entry_id TEXT,
      entry_type TEXT NOT NULL,
      timestamp_iso TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      data_json TEXT,
      FOREIGN KEY(thread_key) REFERENCES runtime_threads(thread_key) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_thread_entries_thread_created
    ON runtime_thread_entries(thread_key, created_at, entry_id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_thread_entries_thread_parent
    ON runtime_thread_entries(thread_key, parent_entry_id, created_at, entry_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_agents (
      thread_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      description TEXT NOT NULL,
      agent_depth INTEGER NOT NULL,
      max_agent_depth INTEGER,
      parent_agent_id TEXT,
      self_mod_metadata_json TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      result TEXT,
      error TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_agents_conversation_updated
    ON runtime_agents(conversation_id, updated_at, thread_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_conversation_state (
      conversation_id TEXT PRIMARY KEY,
      reminder_tokens_since_last_injection INTEGER NOT NULL DEFAULT 0,
      force_reminder_on_next_turn INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL CHECK(target IN ('memory', 'user')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_entries_target_created
    ON memory_entries(target, created_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_memory_review_state (
      conversation_id TEXT PRIMARY KEY,
      user_turns_since_review INTEGER NOT NULL DEFAULT 0,
      last_review_at INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_memory_injection_state (
      conversation_id TEXT PRIMARY KEY,
      user_turns_since_injection INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Per-conversation watermarks for chronicle injection. The chronicle
  // hook gates on file mtime rather than turn count — when the writer
  // bumps `state/memories_extensions/chronicle/{10m,6h}-current.md`, the
  // next `before_user_message` for this conversation injects the fresh
  // summary and advances the watermark. Idle conversations (no user
  // message) never inject; idle conversations that return after a long
  // gap inject once on the next message, picking up the current summary
  // (not a backlog).
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_chronicle_injection_state (
      conversation_id TEXT PRIMARY KEY,
      last_10m_mtime_ms INTEGER NOT NULL DEFAULT 0,
      last_6h_mtime_ms INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Counter for the home-suggestions refresh pass. Increments on every
  // successful General-agent finalize; the cheap-LLM refresh fires when it
  // crosses the threshold and the row is reset to zero. One row per
  // conversation, mirroring the memory-review counter.
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_home_suggestions_state (
      conversation_id TEXT PRIMARY KEY,
      finalizes_since_refresh INTEGER NOT NULL DEFAULT 0,
      last_refresh_at INTEGER
    );
  `);

  // Rolling-window snapshot of recent self-mod commits, named by a cheap
  // LLM. Single row, regenerated on every successful self-mod commit. The
  // side panel reads this row to render the "features list" the user
  // selects from when talking to the Store agent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_mod_feature_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      items_json TEXT NOT NULL,
      generated_at INTEGER NOT NULL
    );
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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_store_installs_installed_at
    ON store_installs(installed_at);
  `);

  // Local Store agent thread. Publishing is backend-validated, but the
  // conversation and blueprint review loop live locally with the agent.
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_summaries (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      rollout_summary TEXT NOT NULL,
      raw_memory TEXT,
      source_updated_at INTEGER NOT NULL,
      processed_by_dream_at INTEGER,
      dream_watermark INTEGER,
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_usage INTEGER,
      PRIMARY KEY (thread_id, run_id)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_thread_summaries_unprocessed
    ON thread_summaries(processed_by_dream_at, source_updated_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_thread_summaries_source_updated
    ON thread_summaries(source_updated_at);
  `);
};
