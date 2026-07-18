// Transcript search (`searchTranscripts`): the durable index over what was
// actually SAID in chat — user/assistant message text across ALL
// conversations. This is what lets Recall answer episodic questions ("where
// did we go on my first drive?") whose only record is a past orchestrator
// conversation: no agent thread, no memory note.

import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import {
  FtsSearchUnavailableError,
  SessionStore,
} from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-transcript-search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = { rootPath, db, store: new SessionStore(db) };
  activeContexts.add(context);
  return context;
};

afterEach(async () => {
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

let eventCounter = 0;

const appendChat = (
  store: SessionStore,
  conversationId: string,
  type: "user_message" | "assistant_message",
  text: string,
  timestamp: number,
): void => {
  eventCounter += 1;
  store.appendEvent({
    conversationId,
    eventId: `evt-${eventCounter}`,
    type,
    timestamp,
    payload: { text },
  });
};

describe("searchTranscripts", () => {
  it("finds user and assistant text across ALL conversations, not just one", () => {
    const { store } = createTestContext();
    appendChat(
      store,
      "conv-june",
      "user_message",
      "where should I go nearby so I can drive sick",
      1_000,
    );
    appendChat(
      store,
      "conv-june",
      "assistant_message",
      "closest good one is Bush Highway, head toward Saguaro Lake",
      2_000,
    );
    appendChat(
      store,
      "conv-july",
      "user_message",
      "I totally forgot where we went when I was driving the first time",
      3_000,
    );

    const hits = store.searchTranscripts({ query: "saguaro lake drive" });
    const texts = hits.map((hit) => hit.text);
    expect(texts).toContain(
      "closest good one is Bush Highway, head toward Saguaro Lake",
    );
    expect(texts).toContain("where should I go nearby so I can drive sick");
    // Hits carry their conversation, role, and timestamp for dated snippets.
    const assistantHit = hits.find((hit) => hit.role === "assistant");
    expect(assistantHit?.conversationId).toBe("conv-june");
    expect(assistantHit?.atMs).toBe(2_000);
  });

  it("ranks multi-token matches above single-token matches, ties newest-first", () => {
    const { store } = createTestContext();
    appendChat(store, "conv-1", "user_message", "the emira is parked", 1_000);
    appendChat(
      store,
      "conv-1",
      "user_message",
      "took the emira out to saguaro lake",
      2_000,
    );
    appendChat(store, "conv-1", "user_message", "emira wash day", 3_000);

    const hits = store.searchTranscripts({ query: "emira saguaro" });
    expect(hits.map((hit) => hit.text)).toEqual([
      "took the emira out to saguaro lake",
      "emira wash day",
      "the emira is parked",
    ]);
  });

  it("ignores tool/system rows and non-text payload fields", () => {
    const { store } = createTestContext();
    appendChat(store, "conv-1", "user_message", "hello there", 1_000);
    // A tool_result mentioning the term must not surface as something said.
    store.appendEvent({
      conversationId: "conv-1",
      eventId: "evt-tool",
      type: "tool_result",
      timestamp: 2_000,
      payload: { text: "zanzibar in a tool result" },
    });
    // Payload metadata (not $.text) mentioning the term must not match.
    store.appendEvent({
      conversationId: "conv-1",
      eventId: "evt-meta",
      type: "user_message",
      timestamp: 3_000,
      payload: { text: "unrelated", platform: "zanzibar" },
    });

    expect(store.searchTranscripts({ query: "zanzibar" })).toEqual([]);
  });

  it("treats LIKE wildcards as literals and returns nothing for empty queries", () => {
    const { store } = createTestContext();
    appendChat(store, "conv-1", "user_message", "reached 100% coverage", 1_000);
    appendChat(
      store,
      "conv-1",
      "user_message",
      "processed 1000 records",
      2_000,
    );

    expect(
      store.searchTranscripts({ query: "100%" }).map((hit) => hit.text),
    ).toEqual(["reached 100% coverage"]);
    expect(store.searchTranscripts({ query: "   " })).toEqual([]);
  });

  it("lists a hit's neighboring chat messages in chronological order", () => {
    const { store } = createTestContext();
    appendChat(store, "conv-1", "user_message", "so where should I go", 1_000);
    appendChat(store, "conv-1", "assistant_message", "try Bush Highway", 2_000);
    appendChat(store, "conv-1", "user_message", "give me the address", 3_000);
    appendChat(store, "conv-1", "user_message", "damn i love the car", 4_000);
    // Another conversation's messages never leak into the neighborhood.
    appendChat(store, "conv-2", "user_message", "unrelated chatter", 2_500);

    const neighbors = store.listTranscriptNeighbors({
      conversationId: "conv-1",
      atMs: 2_000,
      before: 2,
      after: 2,
    });
    expect(neighbors.map((hit) => hit.text)).toEqual([
      "so where should I go",
      "give me the address",
      "damn i love the car",
    ]);
    expect(neighbors.every((hit) => hit.conversationId === "conv-1")).toBe(
      true,
    );
  });

  it("respects the limit", () => {
    const { store } = createTestContext();
    for (let i = 0; i < 5; i += 1) {
      appendChat(store, "conv-1", "user_message", `emira note ${i}`, 1_000 + i);
    }
    expect(store.searchTranscripts({ query: "emira", limit: 2 })).toHaveLength(
      2,
    );
  });
});

// The FTS5 index behind searchTranscripts: trigger-synced at write time so
// the search is an index lookup instead of a full-table json_extract scan.
describe("transcript FTS index", () => {
  const ftsRowCount = (db: SqliteDatabase): number =>
    (
      db.prepare("SELECT COUNT(*) AS count FROM message_text_fts").get() as {
        count: number;
      }
    ).count;

  it("indexes eligible chat rows via triggers and matches stemmed word forms", () => {
    const { store, db } = createTestContext();
    appendChat(
      store,
      "conv-1",
      "user_message",
      "took the car for a drive",
      1_000,
    );
    // Tool rows never reach the index.
    store.appendEvent({
      conversationId: "conv-1",
      eventId: "evt-tool",
      type: "tool_result",
      timestamp: 2_000,
      payload: { text: "drive in a tool result" },
    });

    expect(ftsRowCount(db)).toBe(1);
    // Porter stemming: "drives" finds "drive" — the LIKE scan could not do
    // this, so a hit here also proves the FTS path (not the fallback)
    // answered.
    const hits = store.searchTranscripts({ query: "drives" });
    expect(hits.map((hit) => hit.text)).toEqual(["took the car for a drive"]);
  });

  it("stays in sync when an event's text is rewritten", () => {
    const { store, db } = createTestContext();
    store.appendEvent({
      conversationId: "conv-1",
      eventId: "evt-rewrite",
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "meet me at saguaro lake" },
    });
    // Same eventId → upsert rewrites the message's parts (delete+insert).
    store.appendEvent({
      conversationId: "conv-1",
      eventId: "evt-rewrite",
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "meet me at canyon lake instead" },
    });

    expect(store.searchTranscripts({ query: "saguaro" })).toEqual([]);
    expect(
      store.searchTranscripts({ query: "canyon" }).map((hit) => hit.text),
    ).toEqual(["meet me at canyon lake instead"]);
    expect(ftsRowCount(db)).toBe(1);
  });

  it("drops a deleted conversation's rows via the cascade", () => {
    const { store, db } = createTestContext();
    appendChat(
      store,
      "conv-1",
      "user_message",
      "the secret is zanzibar",
      1_000,
    );
    expect(store.searchTranscripts({ query: "zanzibar" })).toHaveLength(1);

    db.prepare("DELETE FROM session WHERE id = ?").run("conv-1");

    expect(store.searchTranscripts({ query: "zanzibar" })).toEqual([]);
    expect(ftsRowCount(db)).toBe(0);
  });

  it("backfills pre-existing history when the index is rebuilt (upgrade path)", () => {
    const { store, db } = createTestContext();
    appendChat(
      store,
      "conv-1",
      "user_message",
      "remember the emira torque spec",
      1_000,
    );
    // Simulate an old database: index contents and the backfill flag gone.
    db.exec("DELETE FROM message_text_fts;");
    db.prepare("DELETE FROM settings WHERE key = ?").run(
      "transcript_fts_backfilled_v1",
    );
    expect(store.searchTranscripts({ query: "torque" })).toEqual([]);

    initializeDesktopDatabase(db);

    expect(ftsRowCount(db)).toBe(1);
    expect(
      store.searchTranscripts({ query: "torque" }).map((hit) => hit.text),
    ).toEqual(["remember the emira torque spec"]);
  });

  it("fails loudly when the index is unavailable unless degraded mode is explicit", () => {
    const { store, db } = createTestContext();
    appendChat(
      store,
      "conv-1",
      "user_message",
      "the secret is zanzibar",
      1_000,
    );
    db.exec("DROP TRIGGER trg_message_text_fts_part_insert;");
    db.exec("DROP TRIGGER trg_message_text_fts_part_update;");
    db.exec("DROP TRIGGER trg_message_text_fts_part_delete;");
    db.exec("DROP TABLE message_text_fts;");
    // A fresh store re-detects availability (the flag is cached per store).
    const fallbackStore = new SessionStore(db);

    expect(() =>
      fallbackStore.searchTranscripts({ query: "zanzibar" }),
    ).toThrow(FtsSearchUnavailableError);
    expect(
      fallbackStore
        .searchTranscripts({ query: "zanzibar", degradedMode: "like" })
        .map((h) => h.text),
    ).toEqual(["the secret is zanzibar"]);
  });

  it("survives queries FTS cannot tokenize by falling back to the scan", () => {
    const { store } = createTestContext();
    appendChat(store, "conv-1", "user_message", "coverage hit 100%", 1_000);
    // "%%%" tokenizes to nothing inside FTS MATCH (syntax error path) but
    // stays a literal for the LIKE fallback.
    expect(store.searchTranscripts({ query: "%%%" })).toEqual([]);
  });
});
