import fs from "fs";
import path from "path";
import BetterSqliteDatabase from "better-sqlite3";
import type { SqliteDatabase } from "./shared.js";

const DB_FILE = "stella.sqlite";

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const openDatabase = (dbPath: string): SqliteDatabase =>
  new BetterSqliteDatabase(dbPath) as unknown as SqliteDatabase;

export const createDesktopDatabase = (stellaHome: string): SqliteDatabase => {
  const stateRoot = path.join(stellaHome, "state");
  ensureDir(stateRoot);

  const db = openDatabase(path.join(stateRoot, DB_FILE));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA temp_store = MEMORY;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_events (
      _id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      device_id TEXT,
      request_id TEXT,
      target_device_id TEXT,
      payload_json TEXT,
      channel_envelope_json TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_events_conversation_ts
    ON chat_events(conversation_id, timestamp, _id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_events_request
    ON chat_events(conversation_id, request_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sync_checkpoints (
      conversation_id TEXT PRIMARY KEY,
      local_message_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_thread_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_key TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_thread_messages_thread_ts
    ON runtime_thread_messages(thread_key, timestamp, id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      seq INTEGER,
      event_type TEXT NOT NULL,
      chunk TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      result_preview TEXT,
      error TEXT,
      fatal INTEGER,
      final_text TEXT,
      self_mod_applied_json TEXT
    );
  `);
  try {
    db.exec("ALTER TABLE runtime_run_events ADD COLUMN self_mod_applied_json TEXT;");
  } catch {
    // Column already exists.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_run_events_run_seq
    ON runtime_run_events(run_id, seq, id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_run_events_conversation_ts
    ON runtime_run_events(conversation_id, timestamp, id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_memories_timestamp
    ON runtime_memories(timestamp, id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_threads (
      thread_key TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      summary TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_conversation_status
    ON runtime_threads(conversation_id, status, last_used_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_conversation_state (
      conversation_id TEXT PRIMARY KEY,
      reminder_tokens_since_last_injection INTEGER NOT NULL DEFAULT 0,
      force_reminder_on_next_turn INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
};
