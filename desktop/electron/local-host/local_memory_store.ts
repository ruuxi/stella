import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

export type LocalMemorySource = "memory" | "history";
export type LocalMemoryRole = "user" | "assistant" | null;

export type LocalHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type LocalMemoryCandidate = {
  id: number;
  source: LocalMemorySource;
  role: LocalMemoryRole;
  content: string;
  updatedAt: number;
  accessCount: number;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS local_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  source TEXT NOT NULL,
  role TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  accessed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_local_memories_unique
  ON local_memories(conversation_id, source, content_hash);

CREATE INDEX IF NOT EXISTS idx_local_memories_conversation_source_updated
  ON local_memories(conversation_id, source, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS local_memories_fts USING fts5(
  content,
  content='local_memories',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS local_memories_ai AFTER INSERT ON local_memories BEGIN
  INSERT INTO local_memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS local_memories_ad AFTER DELETE ON local_memories BEGIN
  INSERT INTO local_memories_fts(local_memories_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS local_memories_au AFTER UPDATE ON local_memories BEGIN
  INSERT INTO local_memories_fts(local_memories_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO local_memories_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

const normalizeContent = (content: string): string =>
  content.trim().replace(/\s+/g, " ");

const hashContent = (
  source: LocalMemorySource,
  role: LocalMemoryRole,
  content: string,
): string =>
  crypto
    .createHash("sha256")
    .update(`${source}:${role ?? "none"}:${content.toLowerCase()}`)
    .digest("hex");

const buildFtsMatchQuery = (query: string): string | null => {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const unique = Array.from(new Set(tokens.filter((token) => token.length > 0)));
  if (unique.length === 0) return null;
  return unique.map((token) => `${token}*`).join(" OR ");
};

export class LocalMemoryStore {
  private db: BetterSqlite3.Database;
  private upsertStmt: BetterSqlite3.Statement;
  private touchStmt: BetterSqlite3.Statement;
  private searchStmt: BetterSqlite3.Statement;
  private recentStmt: BetterSqlite3.Statement;

  constructor(stellaHome: string) {
    const stateDir = path.join(stellaHome, "state");
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    const dbPath = path.join(stateDir, "local_memory.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);

    this.upsertStmt = this.db.prepare(`
      INSERT INTO local_memories (
        conversation_id,
        source,
        role,
        content,
        content_hash,
        created_at,
        updated_at,
        access_count,
        accessed_at
      )
      VALUES (
        @conversationId,
        @source,
        @role,
        @content,
        @contentHash,
        @now,
        @now,
        0,
        @now
      )
      ON CONFLICT(conversation_id, source, content_hash) DO UPDATE SET
        role = excluded.role,
        content = excluded.content,
        updated_at = excluded.updated_at
    `);

    this.touchStmt = this.db.prepare(`
      UPDATE local_memories
      SET access_count = access_count + 1,
          accessed_at = @now
      WHERE id = @id
    `);

    this.searchStmt = this.db.prepare(`
      SELECT
        m.id AS id,
        m.source AS source,
        m.role AS role,
        m.content AS content,
        m.updated_at AS updatedAt,
        m.access_count AS accessCount,
        bm25(local_memories_fts) AS score
      FROM local_memories_fts
      JOIN local_memories m ON m.id = local_memories_fts.rowid
      WHERE local_memories_fts MATCH @matchQuery
        AND m.conversation_id = @conversationId
        AND m.source = @source
      ORDER BY score ASC, m.updated_at DESC
      LIMIT @limit
    `);

    this.recentStmt = this.db.prepare(`
      SELECT
        m.id AS id,
        m.source AS source,
        m.role AS role,
        m.content AS content,
        m.updated_at AS updatedAt,
        m.access_count AS accessCount
      FROM local_memories m
      WHERE m.conversation_id = @conversationId
        AND m.source = @source
      ORDER BY m.updated_at DESC
      LIMIT @limit
    `);
  }

  private upsert(
    conversationId: string,
    source: LocalMemorySource,
    role: LocalMemoryRole,
    content: string,
  ): void {
    const normalized = normalizeContent(content);
    if (!normalized) return;

    const now = Date.now();
    this.upsertStmt.run({
      conversationId,
      source,
      role,
      content: normalized,
      contentHash: hashContent(source, role, normalized),
      now,
    });
  }

  ingestHistoryMessages(
    conversationId: string,
    messages: LocalHistoryMessage[],
  ): void {
    const tx = this.db.transaction((items: LocalHistoryMessage[]) => {
      for (const message of items) {
        this.upsert(conversationId, "history", message.role, message.content);
      }
    });
    tx(messages);
  }

  saveMemory(conversationId: string, content: string): void {
    this.upsert(conversationId, "memory", null, content);
  }

  search(args: {
    conversationId: string;
    source: LocalMemorySource;
    query: string;
    limit: number;
  }): LocalMemoryCandidate[] {
    const matchQuery = buildFtsMatchQuery(args.query);
    if (!matchQuery) return [];

    const limit = Math.max(1, Math.min(100, Math.floor(args.limit)));
    try {
      const rows = this.searchStmt.all({
        conversationId: args.conversationId,
        source: args.source,
        matchQuery,
        limit,
      }) as Array<{
        id: number;
        source: LocalMemorySource;
        role: string | null;
        content: string;
        updatedAt: number;
        accessCount: number;
      }>;
      return rows.map((row) => ({
        id: row.id,
        source: row.source,
        role:
          row.role === "user" || row.role === "assistant"
            ? row.role
            : null,
        content: row.content,
        updatedAt: row.updatedAt,
        accessCount: row.accessCount ?? 0,
      }));
    } catch {
      const fallback = this.recentStmt.all({
        conversationId: args.conversationId,
        source: args.source,
        limit,
      }) as Array<{
        id: number;
        source: LocalMemorySource;
        role: string | null;
        content: string;
        updatedAt: number;
        accessCount: number;
      }>;
      return fallback.map((row) => ({
        id: row.id,
        source: row.source,
        role:
          row.role === "user" || row.role === "assistant"
            ? row.role
            : null,
        content: row.content,
        updatedAt: row.updatedAt,
        accessCount: row.accessCount ?? 0,
      }));
    }
  }

  touch(ids: number[]): void {
    const now = Date.now();
    const tx = this.db.transaction((items: number[]) => {
      for (const id of items) {
        this.touchStmt.run({ id, now });
      }
    });
    tx(ids);
  }

  close(): void {
    this.db.close();
  }
}
