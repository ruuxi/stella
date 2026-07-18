import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  listTranscriptNeighborsBatch,
  readRecallFtsHealth,
} from "../../../../../runtime/kernel/storage/recall-read-queries.js";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});

const makeDb = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      data_json TEXT NOT NULL
    );
  `);
  return db;
};

describe("Recall read queries", () => {
  it("expands multiple transcript hits in one batched query", () => {
    const db = makeDb();
    const insertMessage = db.prepare(
      "INSERT INTO message (id, session_id, role, type, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const insertPart = db.prepare(
      "INSERT INTO part (id, message_id, data_json) VALUES (?, ?, ?)",
    );
    for (const [id, atMs, text] of [
      ["m1", 100, "before one"],
      ["m2", 200, "hit one"],
      ["m3", 300, "after one"],
      ["m4", 1_000, "before two"],
      ["m5", 1_100, "hit two"],
      ["m6", 1_200, "after two"],
    ] as const) {
      insertMessage.run(id, "conv-1", "user", "user_message", atMs);
      insertPart.run(`p-${id}`, id, JSON.stringify({ text }));
    }

    const rows = listTranscriptNeighborsBatch(
      db as never,
      [
        { conversationId: "conv-1", atMs: 200 },
        { conversationId: "conv-1", atMs: 1_100 },
      ],
      { before: 1, after: 1, windowMs: 500 },
    );

    expect(rows.map((group) => group.map((row) => row.text))).toEqual([
      ["before one", "after one"],
      ["before two", "after two"],
    ]);
  });

  it("reports missing or unbackfilled FTS instead of permitting LIKE fallback", () => {
    const db = makeDb();
    expect(readRecallFtsHealth(db as never)).toMatchObject({
      healthy: false,
      transcriptReady: false,
      threadsReady: false,
    });
  });

  it("proves MATCH execution instead of trusting table names and flags", () => {
    const db = makeDb();
    db.exec(`
      CREATE TABLE message_text_fts (text TEXT);
      CREATE TABLE thread_search_fts (text TEXT);
      INSERT INTO settings (key, value) VALUES
        ('transcript_fts_backfilled_v1', '1'),
        ('thread_search_fts_backfilled_v1', '1');
    `);

    expect(readRecallFtsHealth(db as never)).toMatchObject({
      healthy: false,
      transcriptReady: false,
      threadsReady: false,
    });
    expect(readRecallFtsHealth(db as never).reason).toContain(
      "MATCH probe failed",
    );
  });

  it("reports healthy only when both FTS indexes execute MATCH", () => {
    const db = makeDb();
    db.exec(`
      CREATE VIRTUAL TABLE message_text_fts USING fts5(text);
      CREATE VIRTUAL TABLE thread_search_fts USING fts5(text);
      INSERT INTO settings (key, value) VALUES
        ('transcript_fts_backfilled_v1', '1'),
        ('thread_search_fts_backfilled_v1', '1');
    `);

    expect(readRecallFtsHealth(db as never)).toEqual({
      healthy: true,
      transcriptReady: true,
      threadsReady: true,
    });
  });
});
