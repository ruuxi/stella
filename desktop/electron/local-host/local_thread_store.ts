/**
 * Local Thread Store — SQLite-based thread storage for the local agent runtime.
 *
 * Eliminates Convex round-trips for thread read/write and makes
 * compaction fully local. Uses better-sqlite3 in WAL mode.
 */

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import fs from "fs";

// ── Schema ────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Main',
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  total_token_estimate INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_conversation
  ON threads(conversation_id, status);

CREATE TABLE IF NOT EXISTS thread_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_call_id TEXT,
  token_estimate INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(thread_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread_ordinal
  ON thread_messages(thread_id, ordinal);

CREATE TABLE IF NOT EXISTS active_threads (
  conversation_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  seeded_from_cloud INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

// ── Types ─────────────────────────────────────────────────────────────────

export type LocalThread = {
  id: string;
  conversationId: string;
  name: string;
  status: string;
  summary?: string;
  totalTokenEstimate: number;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type LocalThreadMessage = {
  id: number;
  threadId: string;
  ordinal: number;
  role: string;
  content: string;
  toolCallId?: string;
  tokenEstimate: number;
  createdAt: number;
};

// Simple token estimate: ~4 chars per token
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

// ── LocalThreadStore ──────────────────────────────────────────────────────

export class LocalThreadStore {
  private db: BetterSqlite3.Database;

  // Prepared statements
  private stmtInsertThread: BetterSqlite3.Statement;
  private stmtInsertMessage: BetterSqlite3.Statement;
  private stmtGetThread: BetterSqlite3.Statement;
  private stmtGetThreadByConvAndName: BetterSqlite3.Statement;
  private stmtLoadMessages: BetterSqlite3.Statement;
  private stmtLoadRecentMessages: BetterSqlite3.Statement;
  private stmtListActiveThreads: BetterSqlite3.Statement;
  private stmtUpdateThreadStats: BetterSqlite3.Statement;
  private stmtMaxOrdinal: BetterSqlite3.Statement;

  constructor(stellaHome: string) {
    const stateDir = path.join(stellaHome, "state");
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    const dbPath = path.join(stateDir, "thread_store.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA_SQL);

    this.stmtInsertThread = this.db.prepare(`
      INSERT OR IGNORE INTO threads (id, conversation_id, name, status, summary, total_token_estimate, message_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertMessage = this.db.prepare(`
      INSERT OR REPLACE INTO thread_messages (thread_id, ordinal, role, content, tool_call_id, token_estimate, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetThread = this.db.prepare(`
      SELECT id, conversation_id AS conversationId, name, status, summary,
             total_token_estimate AS totalTokenEstimate, message_count AS messageCount,
             created_at AS createdAt, updated_at AS updatedAt
      FROM threads WHERE id = ?
    `);

    this.stmtGetThreadByConvAndName = this.db.prepare(`
      SELECT id, conversation_id AS conversationId, name, status, summary,
             total_token_estimate AS totalTokenEstimate, message_count AS messageCount,
             created_at AS createdAt, updated_at AS updatedAt
      FROM threads WHERE conversation_id = ? AND name = ? AND status = 'active'
      ORDER BY updated_at DESC LIMIT 1
    `);

    this.stmtLoadMessages = this.db.prepare(`
      SELECT id, thread_id AS threadId, ordinal, role, content,
             tool_call_id AS toolCallId, token_estimate AS tokenEstimate,
             created_at AS createdAt
      FROM thread_messages WHERE thread_id = ?
      ORDER BY ordinal ASC
    `);

    this.stmtLoadRecentMessages = this.db.prepare(`
      SELECT id, thread_id AS threadId, ordinal, role, content,
             tool_call_id AS toolCallId, token_estimate AS tokenEstimate,
             created_at AS createdAt
      FROM thread_messages WHERE thread_id = ?
      ORDER BY ordinal DESC LIMIT ?
    `);

    this.stmtListActiveThreads = this.db.prepare(`
      SELECT id, conversation_id AS conversationId, name, status, summary,
             total_token_estimate AS totalTokenEstimate, message_count AS messageCount,
             created_at AS createdAt, updated_at AS updatedAt
      FROM threads WHERE conversation_id = ? AND status = 'active'
      ORDER BY updated_at DESC
    `);

    this.stmtUpdateThreadStats = this.db.prepare(`
      UPDATE threads SET total_token_estimate = ?, message_count = ?, updated_at = ?
      WHERE id = ?
    `);

    this.stmtMaxOrdinal = this.db.prepare(`
      SELECT MAX(ordinal) AS maxOrdinal FROM thread_messages WHERE thread_id = ?
    `);
  }

  getOrCreateThread(conversationId: string, name = "Main"): LocalThread {
    const existing = this.stmtGetThreadByConvAndName.get(conversationId, name) as LocalThread | undefined;
    if (existing) return existing;

    const id = crypto.randomUUID();
    const now = Date.now();
    this.stmtInsertThread.run(id, conversationId, name, "active", null, 0, 0, now, now);
    return {
      id,
      conversationId,
      name,
      status: "active",
      totalTokenEstimate: 0,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  getThread(threadId: string): LocalThread | null {
    return (this.stmtGetThread.get(threadId) as LocalThread) ?? null;
  }

  listActiveThreads(conversationId: string): LocalThread[] {
    return this.stmtListActiveThreads.all(conversationId) as LocalThread[];
  }

  saveMessages(
    threadId: string,
    messages: Array<{ role: string; content: string; toolCallId?: string }>,
  ): void {
    if (messages.length === 0) return;

    const maxRow = this.stmtMaxOrdinal.get(threadId) as { maxOrdinal: number | null } | undefined;
    let ordinal = (maxRow?.maxOrdinal ?? -1) + 1;
    const now = Date.now();
    let totalNewTokens = 0;

    const insertMany = this.db.transaction(() => {
      for (const msg of messages) {
        const tokens = estimateTokens(msg.content);
        totalNewTokens += tokens;
        this.stmtInsertMessage.run(
          threadId,
          ordinal,
          msg.role,
          msg.content,
          msg.toolCallId ?? null,
          tokens,
          now,
        );
        ordinal++;
      }
    });
    insertMany();

    // Update thread stats
    const thread = this.getThread(threadId);
    if (thread) {
      this.stmtUpdateThreadStats.run(
        thread.totalTokenEstimate + totalNewTokens,
        thread.messageCount + messages.length,
        now,
        threadId,
      );
    }
  }

  loadMessages(threadId: string, limit?: number): LocalThreadMessage[] {
    if (limit) {
      const rows = this.stmtLoadRecentMessages.all(threadId, limit) as LocalThreadMessage[];
      return rows.reverse(); // Return in chronological order
    }
    return this.stmtLoadMessages.all(threadId) as LocalThreadMessage[];
  }

  /**
   * Load messages formatted for the agent context (matching the shape
   * returned by the Convex `loadThreadMessages` query).
   */
  loadMessagesForContext(
    threadId: string,
    limit = 50,
  ): Array<{ role: string; content: string; toolCallId?: string }> {
    const messages = this.loadMessages(threadId, limit);
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    }));
  }

  applyCompaction(
    threadId: string,
    args: {
      cutOrdinal: number;
      summary: string;
      newTokenEstimate: number;
    },
  ): void {
    const { cutOrdinal, summary, newTokenEstimate } = args;

    this.db.transaction(() => {
      // Delete messages up to cutOrdinal
      this.db.prepare(`
        DELETE FROM thread_messages WHERE thread_id = ? AND ordinal <= ?
      `).run(threadId, cutOrdinal);

      // Update thread summary and token estimate
      const remaining = this.db.prepare(`
        SELECT COUNT(*) AS cnt FROM thread_messages WHERE thread_id = ?
      `).get(threadId) as { cnt: number };

      this.db.prepare(`
        UPDATE threads SET summary = ?, total_token_estimate = ?, message_count = ?, updated_at = ?
        WHERE id = ?
      `).run(summary, newTokenEstimate, remaining.cnt, Date.now(), threadId);
    })();
  }

  close(): void {
    this.db.close();
  }
}

// ── Singleton management ──────────────────────────────────────────────────

const stores = new Map<string, LocalThreadStore>();

export const getLocalThreadStore = (stellaHome: string): LocalThreadStore => {
  const existing = stores.get(stellaHome);
  if (existing) return existing;
  const store = new LocalThreadStore(stellaHome);
  stores.set(stellaHome, store);
  return store;
};
