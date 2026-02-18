/**
 * Versioned SQLite migrations for local-first storage.
 * Each migration is run once and tracked in the _migrations table.
 */
import type Database from "better-sqlite3";

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial schema — all core tables",
    up: (db) => {
      db.exec(`
        -- ── Conversations ──────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS conversations (
          id            TEXT PRIMARY KEY,
          owner_id      TEXT NOT NULL,
          title         TEXT,
          is_default    INTEGER NOT NULL DEFAULT 0,
          token_count   INTEGER,
          last_ingested_at        REAL,
          last_extraction_at      REAL,
          last_extraction_token_count INTEGER,
          created_at    REAL NOT NULL,
          updated_at    REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_owner_default
          ON conversations (owner_id, is_default);
        CREATE INDEX IF NOT EXISTS idx_conversations_owner_updated
          ON conversations (owner_id, updated_at);

        -- ── Events ─────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS events (
          id                TEXT PRIMARY KEY,
          conversation_id   TEXT NOT NULL REFERENCES conversations(id),
          timestamp         REAL NOT NULL,
          type              TEXT NOT NULL,
          device_id         TEXT,
          request_id        TEXT,
          target_device_id  TEXT,
          payload           TEXT NOT NULL DEFAULT '{}',
          channel_envelope  TEXT,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_events_conversation
          ON events (conversation_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_conversation_type
          ON events (conversation_id, type, timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_target_device
          ON events (target_device_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_request
          ON events (request_id);

        -- ── Attachments ────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS attachments (
          id                TEXT PRIMARY KEY,
          conversation_id   TEXT NOT NULL,
          device_id         TEXT NOT NULL,
          storage_key       TEXT NOT NULL,
          url               TEXT,
          mime_type         TEXT NOT NULL,
          size              INTEGER NOT NULL,
          created_at        REAL NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_conversation
          ON attachments (conversation_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_device
          ON attachments (device_id);

        -- ── Tasks ──────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS tasks (
          id                TEXT PRIMARY KEY,
          conversation_id   TEXT NOT NULL,
          parent_task_id    TEXT,
          description       TEXT NOT NULL,
          prompt            TEXT NOT NULL,
          agent_type        TEXT NOT NULL,
          status            TEXT NOT NULL DEFAULT 'pending',
          task_depth        INTEGER NOT NULL DEFAULT 0,
          model             TEXT,
          command_id        TEXT,
          result            TEXT,
          error             TEXT,
          status_updates    TEXT,
          created_at        REAL NOT NULL,
          updated_at        REAL NOT NULL,
          completed_at      REAL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_conversation
          ON tasks (conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_conversation_updated
          ON tasks (conversation_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_status
          ON tasks (status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_parent
          ON tasks (parent_task_id, created_at);

        -- ── Threads ────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS threads (
          id                    TEXT PRIMARY KEY,
          conversation_id       TEXT NOT NULL,
          name                  TEXT NOT NULL,
          status                TEXT NOT NULL,
          summary               TEXT,
          message_count         INTEGER NOT NULL DEFAULT 0,
          total_token_estimate  INTEGER NOT NULL DEFAULT 0,
          created_at            REAL NOT NULL,
          last_used_at          REAL NOT NULL,
          resurfaced_at         REAL,
          closed_at             REAL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_threads_conversation_status
          ON threads (conversation_id, status, last_used_at);
        CREATE INDEX IF NOT EXISTS idx_threads_conversation_name
          ON threads (conversation_id, name);
        CREATE INDEX IF NOT EXISTS idx_threads_conversation_last_used
          ON threads (conversation_id, last_used_at);
        CREATE INDEX IF NOT EXISTS idx_threads_status_last_used
          ON threads (status, last_used_at);

        -- ── Thread Messages ────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS thread_messages (
          id              TEXT PRIMARY KEY,
          thread_id       TEXT NOT NULL,
          ordinal         INTEGER NOT NULL,
          role            TEXT NOT NULL,
          content         TEXT NOT NULL,
          tool_call_id    TEXT,
          token_estimate  INTEGER,
          created_at      REAL NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_thread_messages_ordinal
          ON thread_messages (thread_id, ordinal);

        -- ── Memories ───────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS memories (
          id                TEXT PRIMARY KEY,
          owner_id          TEXT NOT NULL,
          conversation_id   TEXT,
          content           TEXT NOT NULL,
          embedding         TEXT,
          accessed_at       REAL NOT NULL,
          created_at        REAL NOT NULL,
          updated_at        REAL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_owner_accessed
          ON memories (owner_id, accessed_at);
        CREATE INDEX IF NOT EXISTS idx_memories_accessed
          ON memories (accessed_at);

        -- ── Memory Extraction Batches ──────────────────────────────
        CREATE TABLE IF NOT EXISTS memory_extraction_batches (
          id                TEXT PRIMARY KEY,
          owner_id          TEXT NOT NULL,
          conversation_id   TEXT,
          trigger           TEXT NOT NULL,
          window_start      REAL NOT NULL,
          window_end        REAL NOT NULL,
          snapshot          TEXT NOT NULL DEFAULT '[]',
          created_at        REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mem_extract_owner_created
          ON memory_extraction_batches (owner_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_mem_extract_owner_conv_created
          ON memory_extraction_batches (owner_id, conversation_id, created_at);

        -- ── Agents ─────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS agents (
          id              TEXT PRIMARY KEY,
          owner_id        TEXT,
          agent_id        TEXT NOT NULL,
          name            TEXT NOT NULL,
          description     TEXT NOT NULL DEFAULT '',
          system_prompt   TEXT NOT NULL,
          agent_types     TEXT NOT NULL DEFAULT '[]',
          tools_allowlist TEXT,
          default_skills  TEXT,
          model           TEXT,
          max_task_depth  INTEGER,
          version         INTEGER NOT NULL DEFAULT 1,
          source          TEXT NOT NULL DEFAULT 'local',
          updated_at      REAL NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_owner_agent_key
          ON agents (owner_id, agent_id);
        CREATE INDEX IF NOT EXISTS idx_agents_owner_updated
          ON agents (owner_id, updated_at);

        -- ── Skills ─────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS skills (
          id                  TEXT PRIMARY KEY,
          owner_id            TEXT,
          skill_id            TEXT NOT NULL,
          name                TEXT NOT NULL,
          description         TEXT NOT NULL DEFAULT '',
          markdown            TEXT NOT NULL,
          agent_types         TEXT NOT NULL DEFAULT '[]',
          tools_allowlist     TEXT,
          tags                TEXT,
          execution           TEXT,
          requires_secrets    TEXT,
          public_integration  INTEGER DEFAULT 0,
          secret_mounts       TEXT,
          version             INTEGER NOT NULL DEFAULT 1,
          source              TEXT NOT NULL DEFAULT 'local',
          enabled             INTEGER NOT NULL DEFAULT 1,
          updated_at          REAL NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_owner_skill_key
          ON skills (owner_id, skill_id);
        CREATE INDEX IF NOT EXISTS idx_skills_owner_enabled
          ON skills (owner_id, enabled);
        CREATE INDEX IF NOT EXISTS idx_skills_owner_updated
          ON skills (owner_id, updated_at);

        -- ── User Preferences ──────────────────────────────────────
        CREATE TABLE IF NOT EXISTS user_preferences (
          id          TEXT PRIMARY KEY,
          owner_id    TEXT NOT NULL,
          key         TEXT NOT NULL,
          value       TEXT NOT NULL,
          updated_at  REAL NOT NULL,
          UNIQUE (owner_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_prefs_owner_key
          ON user_preferences (owner_id, key);

        -- ── Secrets ────────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS secrets (
          id               TEXT PRIMARY KEY,
          owner_id         TEXT NOT NULL,
          provider         TEXT NOT NULL,
          label            TEXT NOT NULL,
          encrypted_value  TEXT NOT NULL,
          key_version      INTEGER NOT NULL DEFAULT 1,
          status           TEXT NOT NULL DEFAULT 'active',
          metadata         TEXT,
          created_at       REAL NOT NULL,
          updated_at       REAL NOT NULL,
          last_used_at     REAL
        );
        CREATE INDEX IF NOT EXISTS idx_secrets_owner_updated
          ON secrets (owner_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_secrets_owner_provider
          ON secrets (owner_id, provider, updated_at);

        -- ── Canvas States ──────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS canvas_states (
          id                TEXT PRIMARY KEY,
          owner_id          TEXT NOT NULL,
          conversation_id   TEXT NOT NULL,
          name              TEXT NOT NULL,
          title             TEXT,
          url               TEXT,
          width             INTEGER,
          updated_at        REAL NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_canvas_owner_conversation
          ON canvas_states (owner_id, conversation_id);
        CREATE INDEX IF NOT EXISTS idx_canvas_owner_updated
          ON canvas_states (owner_id, updated_at);

        -- ── Commands ───────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS commands (
          id          TEXT PRIMARY KEY,
          command_id  TEXT NOT NULL UNIQUE,
          name        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          plugin_name TEXT NOT NULL DEFAULT '',
          content     TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          updated_at  REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_commands_command_id
          ON commands (command_id);
        CREATE INDEX IF NOT EXISTS idx_commands_enabled
          ON commands (enabled, updated_at);

        -- ── Heartbeat Configs ──────────────────────────────────────
        CREATE TABLE IF NOT EXISTS heartbeat_configs (
          id                TEXT PRIMARY KEY,
          owner_id          TEXT NOT NULL,
          conversation_id   TEXT NOT NULL,
          enabled           INTEGER NOT NULL DEFAULT 1,
          interval_ms       INTEGER NOT NULL,
          prompt            TEXT,
          checklist         TEXT,
          ack_max_chars     INTEGER,
          deliver           INTEGER,
          agent_type        TEXT,
          active_hours      TEXT,
          target_device_id  TEXT,
          last_run_at_ms    REAL,
          next_run_at_ms    REAL NOT NULL,
          last_status       TEXT,
          last_error        TEXT,
          last_sent_text    TEXT,
          last_sent_at_ms   REAL,
          created_at        REAL NOT NULL,
          updated_at        REAL NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_heartbeat_owner_conversation
          ON heartbeat_configs (owner_id, conversation_id);
        CREATE INDEX IF NOT EXISTS idx_heartbeat_next_run
          ON heartbeat_configs (next_run_at_ms, owner_id);
        CREATE INDEX IF NOT EXISTS idx_heartbeat_owner_updated
          ON heartbeat_configs (owner_id, updated_at);

        -- ── Cron Jobs ──────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS cron_jobs (
          id                  TEXT PRIMARY KEY,
          owner_id            TEXT NOT NULL,
          conversation_id     TEXT,
          name                TEXT NOT NULL,
          description         TEXT,
          enabled             INTEGER NOT NULL DEFAULT 1,
          schedule            TEXT NOT NULL,
          session_target      TEXT NOT NULL,
          payload             TEXT NOT NULL,
          delete_after_run    INTEGER DEFAULT 0,
          next_run_at_ms      REAL NOT NULL,
          running_at_ms       REAL,
          last_run_at_ms      REAL,
          last_status         TEXT,
          last_error          TEXT,
          last_duration_ms    REAL,
          last_output_preview TEXT,
          created_at          REAL NOT NULL,
          updated_at          REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cron_owner_updated
          ON cron_jobs (owner_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_cron_next_run
          ON cron_jobs (next_run_at_ms, owner_id);

        -- ── Store Packages (cached from cloud) ────────────────────
        CREATE TABLE IF NOT EXISTS store_packages (
          id            TEXT PRIMARY KEY,
          package_id    TEXT NOT NULL UNIQUE,
          name          TEXT NOT NULL,
          author        TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          implementation TEXT,
          type          TEXT NOT NULL,
          mod_payload   TEXT,
          version       TEXT NOT NULL DEFAULT '1.0.0',
          tags          TEXT NOT NULL DEFAULT '[]',
          downloads     INTEGER NOT NULL DEFAULT 0,
          rating        REAL,
          icon          TEXT,
          source_url    TEXT,
          readme        TEXT,
          search_text   TEXT,
          created_at    REAL NOT NULL,
          updated_at    REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_store_pkg_package_id
          ON store_packages (package_id);
        CREATE INDEX IF NOT EXISTS idx_store_pkg_type
          ON store_packages (type, updated_at);
        CREATE INDEX IF NOT EXISTS idx_store_pkg_downloads
          ON store_packages (downloads);

        -- ── Store Installs ─────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS store_installs (
          id                TEXT PRIMARY KEY,
          owner_id          TEXT NOT NULL,
          package_id        TEXT NOT NULL,
          installed_version TEXT NOT NULL,
          installed_at      REAL NOT NULL,
          UNIQUE (owner_id, package_id)
        );
        CREATE INDEX IF NOT EXISTS idx_store_installs_owner
          ON store_installs (owner_id, installed_at);

        -- ── Usage Logs ─────────────────────────────────────────────
        CREATE TABLE IF NOT EXISTS usage_logs (
          id                TEXT PRIMARY KEY,
          owner_id          TEXT NOT NULL,
          conversation_id   TEXT NOT NULL,
          agent_type        TEXT NOT NULL,
          model             TEXT NOT NULL,
          input_tokens      INTEGER,
          output_tokens     INTEGER,
          total_tokens      INTEGER,
          duration_ms       REAL NOT NULL,
          success           INTEGER NOT NULL DEFAULT 1,
          fallback_used     INTEGER DEFAULT 0,
          tool_calls        INTEGER,
          created_at        REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_owner
          ON usage_logs (owner_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_usage_conversation
          ON usage_logs (conversation_id, created_at);

        -- ── Self-Mod Features ──────────────────────────────────────
        CREATE TABLE IF NOT EXISTS self_mod_features (
          id                TEXT PRIMARY KEY,
          feature_id        TEXT NOT NULL UNIQUE,
          owner_id          TEXT NOT NULL,
          conversation_id   TEXT NOT NULL,
          name              TEXT NOT NULL,
          description       TEXT,
          status            TEXT NOT NULL,
          batch_count       INTEGER NOT NULL DEFAULT 0,
          files             TEXT NOT NULL DEFAULT '[]',
          created_at        REAL NOT NULL,
          updated_at        REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_self_mod_owner_updated
          ON self_mod_features (owner_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_self_mod_conversation
          ON self_mod_features (conversation_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_self_mod_feature_id
          ON self_mod_features (feature_id);

        -- ── Sync State (for Phase 2 cloud sync) ───────────────────
        CREATE TABLE IF NOT EXISTS _sync_state (
          id          TEXT PRIMARY KEY,
          table_name  TEXT NOT NULL,
          record_id   TEXT NOT NULL,
          remote_id   TEXT,
          dirty       INTEGER NOT NULL DEFAULT 1,
          synced_at   REAL,
          UNIQUE (table_name, record_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_dirty
          ON _sync_state (dirty, table_name);
      `);
    },
  },
];

/**
 * Run all pending migrations in order.
 * Each migration runs inside a transaction.
 */
export function runMigrations(db: Database.Database): void {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  REAL NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM _migrations").all() as { version: number }[])
      .map((r) => r.version),
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    const run = db.transaction(() => {
      migration.up(db);
      db.prepare(
        "INSERT INTO _migrations (version, description, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.description, Date.now());
    });

    run();
  }
}
