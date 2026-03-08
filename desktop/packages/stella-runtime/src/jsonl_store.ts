import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

declare const globalThis: typeof global & { Bun?: unknown };

export type JsonlThreadMessage = {
  timestamp: number;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  toolCallId?: string;
};

type JsonlRunEvent = {
  timestamp: number;
  runId: string;
  conversationId: string;
  agentType: string;
  seq?: number;
  type: "run_start" | "stream" | "tool_start" | "tool_end" | "error" | "run_end";
  chunk?: string;
  toolCallId?: string;
  toolName?: string;
  resultPreview?: string;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  selfModApplied?: {
    featureId: string;
    files: string[];
    batchIndex: number;
  };
};

type JsonlMemory = {
  timestamp: number;
  conversationId: string;
  content: string;
  tags?: string[];
};

type SqliteStatement = {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close?: () => void;
};

const MAX_RECALL_RESULTS = 8;
const SQLITE_MEMORY_SCAN_LIMIT = 400;
const SQLITE_DB_FILE = "runtime-index.sqlite";

const RUN_EVENT_TYPES = new Set<JsonlRunEvent["type"]>([
  "run_start",
  "stream",
  "tool_start",
  "tool_end",
  "error",
  "run_end",
]);

const fileSafeId = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, "_");

const ensureParentDir = (filePath: string): void => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const readJsonlLines = <T>(filePath: string): T[] => {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) return [];

  const result: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      result.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip malformed entries and continue scanning.
    }
  }
  return result;
};

const appendJsonl = (filePath: string, value: unknown): void => {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
};

const escapeSqlLike = (value: string): string => {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
};

const toJsonTags = (tags?: string[]): string | null => {
  if (!tags || tags.length === 0) return null;
  const cleaned = tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (cleaned.length === 0) return null;
  return JSON.stringify(cleaned);
};

const parseJsonTags = (value: string | null): string[] | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const tags = parsed.filter((entry): entry is string => typeof entry === "string");
    return tags.length > 0 ? tags : undefined;
  } catch {
    return undefined;
  }
};

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
};

const isThreadMessage = (value: unknown): value is JsonlThreadMessage => {
  const row = asObject(value);
  if (!row) return false;
  const role = row.role;
  const toolCallId = row.toolCallId;
  return typeof row.timestamp === "number"
    && typeof row.conversationId === "string"
    && (role === "user" || role === "assistant")
    && typeof row.content === "string"
    && (toolCallId == null || typeof toolCallId === "string");
};

const isRunEvent = (value: unknown): value is JsonlRunEvent => {
  const row = asObject(value);
  if (!row) return false;
  const eventType = row.type;
  const seq = row.seq;
  const fatal = row.fatal;
  return typeof row.timestamp === "number"
    && typeof row.runId === "string"
    && typeof row.conversationId === "string"
    && typeof row.agentType === "string"
    && typeof eventType === "string"
    && RUN_EVENT_TYPES.has(eventType as JsonlRunEvent["type"])
    && (seq == null || typeof seq === "number")
    && (fatal == null || typeof fatal === "boolean");
};

const isMemoryEntry = (value: unknown): value is JsonlMemory => {
  const row = asObject(value);
  if (!row) return false;
  const tags = row.tags;
  return typeof row.timestamp === "number"
    && typeof row.conversationId === "string"
    && typeof row.content === "string"
    && (
      tags == null
      || (
        Array.isArray(tags)
        && tags.every((entry) => typeof entry === "string")
      )
    );
};

const openRuntimeDatabase = (dbPath: string): SqliteDatabase => {
  if (typeof globalThis.Bun !== "undefined") {
    const bunSqlite = require("bun:sqlite") as {
      Database: new (
        filePath: string,
        options?: { create?: boolean; readonly?: boolean },
      ) => SqliteDatabase;
    };
    return new bunSqlite.Database(dbPath, { create: true });
  }

  const BetterSqliteDatabase = require("better-sqlite3") as new (filePath: string) => SqliteDatabase;
  return new BetterSqliteDatabase(dbPath);
};

const scoreMemoryMatches = (
  query: string,
  rows: JsonlMemory[],
): Array<{ row: JsonlMemory; score: number }> => {
  const tokens = query.split(/\s+/).filter((token) => token.length > 0);
  return rows
    .map((row) => {
      const haystack = `${row.content} ${(row.tags ?? []).join(" ")}`.toLowerCase();
      const score = haystack.includes(query)
        ? 2
        : tokens.reduce((acc, token) => (haystack.includes(token) ? acc + 1 : acc), 0);
      return { row, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.row.timestamp - a.row.timestamp;
    });
};

export class JsonlRuntimeStore {
  private readonly root: string;
  private readonly threadsDir: string;
  private readonly threadArchiveDir: string;
  private readonly runsDir: string;
  private readonly memoryFile: string;
  private readonly sqliteFile: string;
  private readonly db: SqliteDatabase | null;
  private readonly threadNeedsResync = new Set<string>();
  private memoryNeedsResync = false;

  constructor(stellaHome: string) {
    this.root = path.join(stellaHome, "state", "stella-runtime");
    this.threadsDir = path.join(this.root, "threads");
    this.threadArchiveDir = path.join(this.threadsDir, "archive");
    this.runsDir = path.join(this.root, "runs");
    this.memoryFile = path.join(this.root, "memory.jsonl");
    this.sqliteFile = path.join(this.root, SQLITE_DB_FILE);

    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.threadsDir, { recursive: true });
    fs.mkdirSync(this.threadArchiveDir, { recursive: true });
    fs.mkdirSync(this.runsDir, { recursive: true });

    this.db = this.initDatabase();
    if (this.db) {
      this.syncAllFromJsonl();
    }
  }

  private initDatabase(): SqliteDatabase | null {
    try {
      const db = openRuntimeDatabase(this.sqliteFile);
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      db.exec("PRAGMA temp_store = MEMORY;");

      db.exec(`
        CREATE TABLE IF NOT EXISTS thread_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          tool_call_id TEXT
        );
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_thread_messages_conversation_ts
        ON thread_messages(conversation_id, timestamp, id);
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS run_events (
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
          final_text TEXT
        );
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_run_events_run_seq
        ON run_events(run_id, seq, id);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_run_events_conversation_ts
        ON run_events(conversation_id, timestamp, id);
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          conversation_id TEXT NOT NULL,
          content TEXT NOT NULL,
          tags_json TEXT
        );
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_timestamp
        ON memories(timestamp, id);
      `);

      return db;
    } catch {
      return null;
    }
  }

  private withTransaction(work: () => void): void {
    if (!this.db) return;
    this.db.exec("BEGIN TRANSACTION;");
    try {
      work();
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private getCount(sql: string, ...params: unknown[]): number {
    if (!this.db) return 0;
    const row = this.db.prepare(sql).get(...params) as { count?: unknown } | undefined;
    const value = row?.count;
    return typeof value === "number" ? value : 0;
  }

  private syncAllFromJsonl(): void {
    if (!this.db) return;
    try {
      this.syncAllThreadFilesFromJsonl();
      this.syncAllRunFilesFromJsonl();
      this.syncMemoriesFromJsonl();
    } catch {
      // SQLite catch-up failed; will fall back to JSONL reads.
    }
  }

  private syncAllThreadFilesFromJsonl(): void {
    if (!this.db) return;
    const entries = fs.readdirSync(this.threadsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(this.threadsDir, entry.name);
      const rows = readJsonlLines<unknown>(filePath).filter(isThreadMessage);
      if (rows.length === 0) continue;

      const grouped = new Map<string, JsonlThreadMessage[]>();
      for (const row of rows) {
        const bucket = grouped.get(row.conversationId);
        if (bucket) {
          bucket.push(row);
        } else {
          grouped.set(row.conversationId, [row]);
        }
      }

      for (const [conversationId, messages] of grouped) {
        this.syncThreadMessagesForConversation(conversationId, messages);
      }
    }
  }

  private syncSingleConversationFromJsonl(conversationId: string): void {
    if (!this.db) return;
    const filePath = path.join(this.threadsDir, `${fileSafeId(conversationId)}.jsonl`);
    const rows = readJsonlLines<unknown>(filePath)
      .filter(isThreadMessage)
      .filter((row) => row.conversationId === conversationId);
    this.syncThreadMessagesForConversation(conversationId, rows);
  }

  private syncThreadMessagesForConversation(conversationId: string, rows: JsonlThreadMessage[]): void {
    if (!this.db) return;
    const dbCount = this.getCount(
      "SELECT COUNT(*) AS count FROM thread_messages WHERE conversation_id = ?",
      conversationId,
    );
    if (dbCount > rows.length) {
      this.db.prepare("DELETE FROM thread_messages WHERE conversation_id = ?").run(conversationId);
      this.insertThreadMessages(rows);
      return;
    }
    if (dbCount < rows.length) {
      this.insertThreadMessages(rows.slice(dbCount));
    }
  }

  private syncAllRunFilesFromJsonl(): void {
    if (!this.db) return;
    const entries = fs.readdirSync(this.runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(this.runsDir, entry.name);
      const rows = readJsonlLines<unknown>(filePath).filter(isRunEvent);
      if (rows.length === 0) continue;

      const grouped = new Map<string, JsonlRunEvent[]>();
      for (const row of rows) {
        const bucket = grouped.get(row.runId);
        if (bucket) {
          bucket.push(row);
        } else {
          grouped.set(row.runId, [row]);
        }
      }

      for (const [runId, events] of grouped) {
        this.syncRunEventsForRun(runId, events);
      }
    }
  }

  private syncRunEventsForRun(runId: string, rows: JsonlRunEvent[]): void {
    if (!this.db) return;
    const dbCount = this.getCount(
      "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?",
      runId,
    );
    if (dbCount > rows.length) {
      this.db.prepare("DELETE FROM run_events WHERE run_id = ?").run(runId);
      this.insertRunEvents(rows);
      return;
    }
    if (dbCount < rows.length) {
      this.insertRunEvents(rows.slice(dbCount));
    }
  }

  private syncMemoriesFromJsonl(forceRebuild = false): void {
    if (!this.db) return;
    const rows = readJsonlLines<unknown>(this.memoryFile).filter(isMemoryEntry);
    const dbCount = this.getCount("SELECT COUNT(*) AS count FROM memories");
    if (forceRebuild || dbCount > rows.length) {
      this.db.exec("DELETE FROM memories;");
      this.insertMemories(rows);
      this.memoryNeedsResync = false;
      return;
    }
    if (dbCount < rows.length) {
      this.insertMemories(rows.slice(dbCount));
    }
    this.memoryNeedsResync = false;
  }

  private insertThreadMessage(message: JsonlThreadMessage): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO thread_messages (timestamp, conversation_id, role, content, tool_call_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      message.timestamp,
      message.conversationId,
      message.role,
      message.content,
      message.toolCallId ?? null,
    );
  }

  private insertThreadMessages(messages: JsonlThreadMessage[]): void {
    if (!this.db || messages.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO thread_messages (timestamp, conversation_id, role, content, tool_call_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.withTransaction(() => {
      for (const message of messages) {
        stmt.run(
          message.timestamp,
          message.conversationId,
          message.role,
          message.content,
          message.toolCallId ?? null,
        );
      }
    });
  }

  private insertRunEvent(event: JsonlRunEvent): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO run_events (
        timestamp,
        run_id,
        conversation_id,
        agent_type,
        seq,
        event_type,
        chunk,
        tool_call_id,
        tool_name,
        result_preview,
        error,
        fatal,
        final_text
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.timestamp,
      event.runId,
      event.conversationId,
      event.agentType,
      event.seq ?? null,
      event.type,
      event.chunk ?? null,
      event.toolCallId ?? null,
      event.toolName ?? null,
      event.resultPreview ?? null,
      event.error ?? null,
      event.fatal == null ? null : (event.fatal ? 1 : 0),
      event.finalText ?? null,
    );
  }

  private insertRunEvents(events: JsonlRunEvent[]): void {
    if (!this.db || events.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO run_events (
        timestamp,
        run_id,
        conversation_id,
        agent_type,
        seq,
        event_type,
        chunk,
        tool_call_id,
        tool_name,
        result_preview,
        error,
        fatal,
        final_text
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.withTransaction(() => {
      for (const event of events) {
        stmt.run(
          event.timestamp,
          event.runId,
          event.conversationId,
          event.agentType,
          event.seq ?? null,
          event.type,
          event.chunk ?? null,
          event.toolCallId ?? null,
          event.toolName ?? null,
          event.resultPreview ?? null,
          event.error ?? null,
          event.fatal == null ? null : (event.fatal ? 1 : 0),
          event.finalText ?? null,
        );
      }
    });
  }

  private insertMemory(entry: JsonlMemory): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO memories (timestamp, conversation_id, content, tags_json)
      VALUES (?, ?, ?, ?)
    `).run(
      entry.timestamp,
      entry.conversationId,
      entry.content,
      toJsonTags(entry.tags),
    );
  }

  private insertMemories(entries: JsonlMemory[]): void {
    if (!this.db || entries.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO memories (timestamp, conversation_id, content, tags_json)
      VALUES (?, ?, ?, ?)
    `);
    this.withTransaction(() => {
      for (const entry of entries) {
        stmt.run(
          entry.timestamp,
          entry.conversationId,
          entry.content,
          toJsonTags(entry.tags),
        );
      }
    });
  }

  appendThreadMessage(message: JsonlThreadMessage): void {
    const filePath = path.join(this.threadsDir, `${fileSafeId(message.conversationId)}.jsonl`);
    appendJsonl(filePath, message);
    if (!this.db) return;
    try {
      this.insertThreadMessage(message);
      this.threadNeedsResync.delete(message.conversationId);
    } catch {
      this.threadNeedsResync.add(message.conversationId);
    }
  }

  loadThreadMessages(
    conversationId: string,
    limit?: number,
  ): Array<{ role: string; content: string; toolCallId?: string }> {
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : undefined;
    if (!this.db) {
      return this.loadThreadMessagesFromJsonl(conversationId, normalizedLimit);
    }

    if (this.threadNeedsResync.has(conversationId)) {
      try {
        this.syncSingleConversationFromJsonl(conversationId);
        this.threadNeedsResync.delete(conversationId);
      } catch {
        return this.loadThreadMessagesFromJsonl(conversationId, normalizedLimit);
      }
    }

    try {
      const sql = `
        SELECT role, content, tool_call_id AS toolCallId
        FROM (
          SELECT id, timestamp, role, content, tool_call_id
          FROM thread_messages
          WHERE conversation_id = ?
          ORDER BY timestamp DESC, id DESC
          ${normalizedLimit ? "LIMIT ?" : ""}
        ) recent
        ORDER BY timestamp ASC, id ASC
      `;
      const rows = (
        normalizedLimit
          ? this.db.prepare(sql).all(conversationId, normalizedLimit)
          : this.db.prepare(sql).all(conversationId)
      ) as Array<{
        role: string;
        content: string;
        toolCallId: string | null;
      }>;

      return rows.map((row) => ({
        role: row.role,
        content: row.content,
        ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
      }));
    } catch {
      return this.loadThreadMessagesFromJsonl(conversationId, normalizedLimit);
    }
  }

  private loadThreadMessagesFromJsonl(
    conversationId: string,
    limit?: number,
  ): Array<{ role: string; content: string; toolCallId?: string }> {
    const filePath = path.join(this.threadsDir, `${fileSafeId(conversationId)}.jsonl`);
    const rows = readJsonlLines<JsonlThreadMessage>(filePath);
    if (rows.length === 0) return [];

    const sliced =
      typeof limit === "number"
        ? rows.slice(-Math.max(1, limit))
        : rows;
    return sliced.map((row) => ({
      role: row.role,
      content: row.content,
      ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
    }));
  }

  replaceThreadMessages(
    conversationId: string,
    nextMessages: JsonlThreadMessage[],
  ): void {
    const filePath = path.join(this.threadsDir, `${fileSafeId(conversationId)}.jsonl`);

    const lines = nextMessages.map((message) => JSON.stringify(message));
    if (lines.length > 0) {
      ensureParentDir(filePath);
      fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
    } else if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    if (this.db) {
      this.withTransaction(() => {
        this.db!.prepare("DELETE FROM thread_messages WHERE conversation_id = ?").run(conversationId);
        for (const message of nextMessages) {
          this.insertThreadMessage(message);
        }
      });
      this.threadNeedsResync.delete(conversationId);
    }
  }

  archiveAndReplaceThreadMessages(
    conversationId: string,
    nextMessages: JsonlThreadMessage[],
  ): string | null {
    const archivedPath = this.archiveCurrentThread(conversationId);
    this.replaceThreadMessages(conversationId, nextMessages);
    return archivedPath;
  }

  archiveCurrentThread(conversationId: string): string | null {
    const filePath = path.join(this.threadsDir, `${fileSafeId(conversationId)}.jsonl`);
    const currentRows = readJsonlLines<unknown>(filePath)
      .filter(isThreadMessage)
      .filter((row) => row.conversationId === conversationId);

    let archivedPath: string | null = null;
    if (currentRows.length > 0) {
      const conversationArchiveDir = path.join(
        this.threadArchiveDir,
        fileSafeId(conversationId),
      );
      fs.mkdirSync(conversationArchiveDir, { recursive: true });
      archivedPath = path.join(
        conversationArchiveDir,
        `${Date.now()}.jsonl`,
      );
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, archivedPath);
      } else {
        const lines = currentRows.map((row) => JSON.stringify(row));
        fs.writeFileSync(archivedPath, `${lines.join("\n")}\n`, "utf-8");
      }
    }
    return archivedPath;
  }

  recordRunEvent(event: JsonlRunEvent): void {
    const filePath = path.join(this.runsDir, `${fileSafeId(event.runId)}.jsonl`);
    appendJsonl(filePath, event);
    if (!this.db) return;
    try {
      this.insertRunEvent(event);
    } catch {
      // Failed to mirror run event to SQLite; JSONL remains the source of truth.
    }
  }

  saveMemory(args: { conversationId: string; content: string; tags?: string[] }): void {
    const content = args.content.trim();
    if (!content) return;

    const tags = args.tags
      ?.map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    const entry: JsonlMemory = {
      timestamp: Date.now(),
      conversationId: args.conversationId,
      content,
      ...(tags && tags.length > 0 ? { tags } : {}),
    };
    appendJsonl(this.memoryFile, entry);
    if (!this.db) return;
    try {
      this.insertMemory(entry);
      this.memoryNeedsResync = false;
    } catch {
      this.memoryNeedsResync = true;
    }
  }

  recallMemories(args: { query: string; limit?: number }): JsonlMemory[] {
    const query = args.query.trim().toLowerCase();
    if (!query) return [];
    const limit = Math.max(1, Math.min(MAX_RECALL_RESULTS, args.limit ?? MAX_RECALL_RESULTS));
    if (!this.db) {
      return this.recallMemoriesFromJsonl(query, limit);
    }

    if (this.memoryNeedsResync) {
      try {
        this.syncMemoriesFromJsonl();
      } catch {
        return this.recallMemoriesFromJsonl(query, limit);
      }
    }

    try {
      const queryTokens = Array.from(new Set(query.split(/\s+/).filter((token) => token.length > 0)));
      const terms = [query, ...queryTokens];
      const whereClauses = terms
        .map(() => "lower(content || ' ' || coalesce(tags_json, '')) LIKE ? ESCAPE '\\'");
      const params = terms.map((term) => `%${escapeSqlLike(term)}%`);

      const sql = `
        SELECT timestamp, conversation_id AS conversationId, content, tags_json AS tagsJson
        FROM memories
        ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(" OR ")}` : ""}
        ORDER BY timestamp DESC
        LIMIT ?
      `;

      const rows = this.db.prepare(sql).all(
        ...params,
        SQLITE_MEMORY_SCAN_LIMIT,
      ) as Array<{
        timestamp: number;
        conversationId: string;
        content: string;
        tagsJson: string | null;
      }>;

      if (rows.length === 0) return [];
      const normalizedRows: JsonlMemory[] = rows.map((row) => ({
        timestamp: row.timestamp,
        conversationId: row.conversationId,
        content: row.content,
        ...(parseJsonTags(row.tagsJson) ? { tags: parseJsonTags(row.tagsJson) } : {}),
      }));
      const scored = scoreMemoryMatches(query, normalizedRows);
      return scored.slice(0, limit).map((entry) => entry.row);
    } catch {
      return this.recallMemoriesFromJsonl(query, limit);
    }
  }

  private recallMemoriesFromJsonl(query: string, limit: number): JsonlMemory[] {
    const rows = readJsonlLines<JsonlMemory>(this.memoryFile);
    if (rows.length === 0) return [];
    const scored = scoreMemoryMatches(query, rows);
    return scored.slice(0, limit).map((entry) => entry.row);
  }

  close(): void {
    this.db?.close?.();
  }
}
