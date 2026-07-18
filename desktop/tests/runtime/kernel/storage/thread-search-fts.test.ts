// The FTS5 index behind `searchThreads` (`thread_search_fts`): trigger-synced
// at write time so thread search is an index lookup instead of a per-token
// LIKE scan — and, the main quality win, the agent's final result/error text
// becomes searchable, which no LIKE column ever was.

import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    `stella-thread-search-fts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

beforeEach(() => {
  // last_used_at is driven by Date.now(); recency tie-breaks in the search
  // ordering need strictly increasing spawn times to be deterministic.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

/** Spawn a new general thread, advancing fake time so recency is strict. */
const spawnThread = (
  store: SessionStore,
  conversationId: string,
  nameHint: string,
) => {
  vi.advanceTimersByTime(1_000);
  return store.resolveOrCreateActiveThread({
    conversationId,
    agentType: "general",
    nameHint,
  });
};

/** Persist an agent record through the production writer (fires triggers). */
const saveAgent = (
  store: SessionStore,
  threadId: string,
  conversationId: string,
  fields: { description?: string; result?: string; error?: string },
) => {
  store.saveAgentRecord({
    threadId,
    conversationId,
    agentType: "general",
    description: fields.description ?? "delegated work",
    agentDepth: 0,
    status: fields.error ? "error" : "completed",
    startedAt: Date.now(),
    completedAt: Date.now(),
    ...(fields.result ? { result: fields.result } : {}),
    ...(fields.error ? { error: fields.error } : {}),
    updatedAt: Date.now(),
  });
};

const ftsRowCount = (db: SqliteDatabase): number =>
  (
    db.prepare("SELECT COUNT(*) AS count FROM thread_search_fts").get() as {
      count: number;
    }
  ).count;

const ftsRowCountForThread = (db: SqliteDatabase, threadKey: string): number =>
  (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM thread_search_fts WHERE thread_key = ?",
      )
      .get(threadKey) as { count: number }
  ).count;

describe("thread FTS index", () => {
  it("finds a thread by a word that appears ONLY in the agent's final result", () => {
    const { store } = createTestContext();
    const quiet = spawnThread(store, "conv-a", "Quiet thread");
    spawnThread(store, "conv-a", "Other thread");
    saveAgent(store, quiet.threadId, "conv-a", {
      result: "Deployed rev 42 behind the zanzibar feature flag.",
    });

    const hits = store.searchThreads({
      conversationId: "conv-a",
      query: "zanzibar",
    });
    expect(hits.map((t) => t.threadId)).toEqual([quiet.threadId]);
  });

  it("finds a thread by a word that appears ONLY in the agent's error text", () => {
    const { store } = createTestContext();
    const failed = spawnThread(store, "conv-a", "Fetch forecast");
    saveAgent(store, failed.threadId, "conv-a", {
      error: "quota exceeded for weatherapi key",
    });

    const hits = store.searchThreads({
      conversationId: "conv-a",
      query: "weatherapi",
    });
    expect(hits.map((t) => t.threadId)).toEqual([failed.threadId]);
  });

  it("matches stemmed word forms — proof the FTS path answered, since LIKE cannot stem", () => {
    const { store } = createTestContext();
    const deploy = spawnThread(store, "conv-a", "Deploy the backend");
    spawnThread(store, "conv-a", "Organize tax documents");

    const hits = store.searchThreads({
      conversationId: "conv-a",
      query: "deploys",
    });
    expect(hits.map((t) => t.threadId)).toEqual([deploy.threadId]);
  });

  it("indexes thread_key so id fragments are searchable", () => {
    const { store } = createTestContext();
    vi.advanceTimersByTime(1_000);
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-a",
      agentType: "general",
      threadId: "wf-connector-discovery-9f3",
      nameHint: "Probe available integrations",
    });

    const hits = store.searchThreads({
      conversationId: "conv-a",
      query: "discovery",
    });
    expect(hits.map((t) => t.threadId)).toEqual([threadId]);
  });

  it("rebuilds a thread's row on summary updates without duplicating it", () => {
    const { db, store } = createTestContext();
    const job = spawnThread(store, "conv-a", "Quiet job");
    store.updateThreadSummary(job.threadId, "researching saguaro trails");
    expect(
      store
        .searchThreads({ conversationId: "conv-a", query: "saguaro" })
        .map((t) => t.threadId),
    ).toEqual([job.threadId]);

    store.updateThreadSummary(job.threadId, "researching canyon trails");

    expect(
      store.searchThreads({ conversationId: "conv-a", query: "saguaro" }),
    ).toEqual([]);
    expect(
      store
        .searchThreads({ conversationId: "conv-a", query: "canyon" })
        .map((t) => t.threadId),
    ).toEqual([job.threadId]);
    expect(ftsRowCountForThread(db, job.threadId)).toBe(1);
  });

  it("rebuilds a thread's row on repeated agent upserts without duplicating it", () => {
    const { db, store } = createTestContext();
    const job = spawnThread(store, "conv-a", "Long job");
    saveAgent(store, job.threadId, "conv-a", {
      description: "crunching numbers",
    });
    saveAgent(store, job.threadId, "conv-a", {
      description: "crunching numbers",
      result: "found the discrepancy in ledger B",
    });

    expect(
      store
        .searchThreads({ conversationId: "conv-a", query: "ledger" })
        .map((t) => t.threadId),
    ).toEqual([job.threadId]);
    expect(ftsRowCountForThread(db, job.threadId)).toBe(1);
    expect(ftsRowCount(db)).toBe(1);
  });

  it("skips the FTS rebuild when an agent save changes no indexed text", () => {
    const { db, store } = createTestContext();
    const job = spawnThread(store, "conv-a", "Long job");
    const fields = {
      description: "crunching numbers",
      result: "found the discrepancy in ledger B",
    };
    saveAgent(store, job.threadId, "conv-a", fields);

    // saveAgentRecord's upsert SETs every column, so UPDATE OF fires on
    // membership alone; the trigger's WHEN clause must reject the no-op.
    // total_changes() counts trigger-driven writes too — an FTS
    // delete+insert lands ~14 shadow-table changes — so a redundant save
    // must cost strictly fewer row changes than one that syncs new text.
    const changes = () =>
      (db.prepare("SELECT total_changes() AS c").get() as { c: number }).c;
    const beforeRedundant = changes();
    saveAgent(store, job.threadId, "conv-a", fields);
    const redundantDelta = changes() - beforeRedundant;

    // A save that DOES change indexed text still syncs.
    const beforeChanging = changes();
    saveAgent(store, job.threadId, "conv-a", {
      ...fields,
      result: "reconciled ledger B against the bank export",
    });
    const changingDelta = changes() - beforeChanging;
    expect(redundantDelta).toBeLessThan(changingDelta);
    expect(
      store
        .searchThreads({ conversationId: "conv-a", query: "reconciled bank" })
        .map((t) => t.threadId),
    ).toEqual([job.threadId]);
    expect(ftsRowCountForThread(db, job.threadId)).toBe(1);
  });

  it("never indexes orchestrator threads or implicit ::subagent:: rows", () => {
    const { db, store } = createTestContext();
    vi.advanceTimersByTime(1_000);
    store.resolveOrCreateActiveThread({
      conversationId: "conv-a",
      agentType: "orchestrator",
      nameHint: "Coordinate flight booking",
    });
    // Simulate an ephemeral workflow agent's implicit transcript row.
    store.updateThreadSummary(
      "conv-a::subagent::general::wf-research-a1",
      "internal flight transcript",
    );
    const real = spawnThread(store, "conv-a", "Book flight seats");

    expect(ftsRowCount(db)).toBe(1);
    expect(ftsRowCountForThread(db, real.threadId)).toBe(1);
    expect(
      store
        .searchThreads({ conversationId: "conv-a", query: "flight" })
        .map((t) => t.threadId),
    ).toEqual([real.threadId]);
  });

  it("keeps the LIKE scan's ordering: scope, then matched-token count, then recency", () => {
    const { store } = createTestContext();
    const both = spawnThread(store, "conv-mine", "Compare flight prices Tokyo");
    const hotel = spawnThread(store, "conv-mine", "Compare hotel prices Tokyo");
    const paris = spawnThread(
      store,
      "conv-mine",
      "Compare flight prices Paris",
    );
    // Newest AND a two-token match — scope still sorts it last.
    const other = spawnThread(store, "conv-other", "Flight tokyo planner");

    const results = store.searchThreads({
      conversationId: "conv-mine",
      query: "flight tokyo",
    });
    expect(results.map((t) => t.threadId)).toEqual([
      both.threadId,
      paris.threadId,
      hotel.threadId,
      other.threadId,
    ]);
  });

  it("backfills pre-existing threads when the index is rebuilt (upgrade path)", () => {
    const { db, store } = createTestContext();
    const job = spawnThread(store, "conv-a", "Quiet thread");
    saveAgent(store, job.threadId, "conv-a", {
      result: "shipped the zanzibar rollout",
    });
    // Simulate an old database: index contents and the backfill flag gone.
    db.exec("DELETE FROM thread_search_fts;");
    db.prepare("DELETE FROM settings WHERE key = ?").run(
      "thread_search_fts_backfilled_v1",
    );
    expect(
      store.searchThreads({ conversationId: "conv-a", query: "zanzibar" }),
    ).toEqual([]);

    initializeDesktopDatabase(db);

    expect(ftsRowCount(db)).toBe(1);
    expect(
      store
        .searchThreads({ conversationId: "conv-a", query: "zanzibar" })
        .map((t) => t.threadId),
    ).toEqual([job.threadId]);
  });

  it("fails loudly when the index is unavailable unless degraded mode is explicit", () => {
    const { db, store } = createTestContext();
    const flight = spawnThread(store, "conv-a", "Compare flight prices");
    saveAgent(store, flight.threadId, "conv-a", {
      result: "the zanzibar route was cheapest",
    });
    db.exec("DROP TRIGGER trg_thread_search_fts_thread_insert;");
    db.exec("DROP TRIGGER trg_thread_search_fts_thread_update;");
    db.exec("DROP TRIGGER trg_thread_search_fts_thread_delete;");
    db.exec("DROP TRIGGER trg_thread_search_fts_agent_insert;");
    db.exec("DROP TRIGGER trg_thread_search_fts_agent_update;");
    db.exec("DROP TRIGGER trg_thread_search_fts_agent_delete;");
    db.exec("DROP TABLE thread_search_fts;");
    // A fresh store re-detects availability (the flag is cached per store).
    const fallbackStore = new SessionStore(db);

    expect(() =>
      fallbackStore.searchThreads({
        conversationId: "conv-a",
        query: "flight",
      }),
    ).toThrow(FtsSearchUnavailableError);
    expect(
      fallbackStore
        .searchThreads({
          conversationId: "conv-a",
          query: "flight",
          degradedMode: "like",
        })
        .map((t) => t.threadId),
    ).toEqual([flight.threadId]);
    // Result-text matching is deliberately exclusive to the FTS path: the
    // LIKE fallback keeps its original narrower column set.
    expect(
      fallbackStore.searchThreads({
        conversationId: "conv-a",
        query: "zanzibar",
        degradedMode: "like",
      }),
    ).toEqual([]);
  });

  it("survives queries FTS cannot tokenize by falling back to the scan", () => {
    const { store } = createTestContext();
    const percent = spawnThread(store, "conv-a", "Reach 100% test coverage");
    spawnThread(store, "conv-a", "Process 1000 records");
    // "%%%" tokenizes to nothing inside FTS MATCH (syntax error path) but
    // stays a literal for the LIKE fallback.
    expect(
      store.searchThreads({ conversationId: "conv-a", query: "%%%" }),
    ).toEqual([]);
    expect(
      store
        .searchThreads({ conversationId: "conv-a", query: "100%" })
        .map((t) => t.threadId),
    ).toEqual([percent.threadId]);
  });

  it("drops a deleted thread's row via the delete trigger", () => {
    const { db, store } = createTestContext();
    const job = spawnThread(store, "conv-a", "Doomed thread");
    expect(ftsRowCountForThread(db, job.threadId)).toBe(1);

    db.prepare("DELETE FROM runtime_threads WHERE thread_key = ?").run(
      job.threadId,
    );

    expect(ftsRowCount(db)).toBe(0);
    expect(
      store.searchThreads({ conversationId: "conv-a", query: "doomed" }),
    ).toEqual([]);
  });
});
