import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeDesktopDatabase } from "../../../../../runtime/kernel/storage/database-init.js";
import { SelfModPendingStore } from "../../../../../runtime/kernel/storage/self-mod-pending-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

const applyResult = (runId: string) => ({
  appliedRuns: [
    {
      runId,
      paths: [`desktop/src/${runId}.tsx`],
      files: [
        {
          path: `desktop/src/${runId}.tsx`,
          content: `export const ${runId.replaceAll("-", "_")} = true;\n`,
        },
      ],
      runtimeRestartRelevantPaths: [],
      processRestartRelevantPaths: [],
      restartRelevantPaths: [],
      fullReloadRelevantPaths: [`desktop/src/${runId}.tsx`],
    },
  ],
  restartRelevantRunIds: [runId],
  hasRestartRelevantPaths: false,
  hasRuntimeRestartRelevantPaths: false,
  hasProcessRestartRelevantPaths: false,
  hasFullReloadRelevantPaths: true,
});

describe("SelfModPendingStore", () => {
  let db: SqliteDatabase;
  let store: SelfModPendingStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    store = new SelfModPendingStore(db, "/repo/stella");
  });

  afterEach(() => {
    db.close();
  });

  it("creates the complete current ledger schema on a fresh database", () => {
    expect(() => initializeDesktopDatabase(db)).not.toThrow();
    expect(
      db
        .prepare("PRAGMA table_info(self_mod_pending_change_sets);")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual([
      "change_set_id",
      "repo_root",
      "conversation_id",
      "owner_thread_id",
      "completion_event_id",
      "assistant_message_event_id",
      "commit_hashes_json",
      "status",
      "created_at",
      "updated_at",
    ]);
    const changeSetIndexes = db
      .prepare("PRAGMA index_list(self_mod_pending_change_sets);")
      .all() as Array<{ name: string; unique: number }>;
    expect(
      changeSetIndexes.some((index) => {
        if (index.unique !== 1) return false;
        const columns = db
          .prepare(`PRAGMA index_info(${index.name});`)
          .all()
          .map((row) => (row as { name: string }).name);
        return columns.join(",") === "repo_root,completion_event_id";
      }),
    ).toBe(true);
    const contributionIndexes = db
      .prepare("PRAGMA index_list(self_mod_pending_contributions);")
      .all() as Array<{ name: string; unique: number }>;
    expect(contributionIndexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_self_mod_pending_unpublished_owner",
        "idx_self_mod_pending_change_set",
      ]),
    );
    expect(
      contributionIndexes.some((index) => {
        if (index.unique !== 1) return false;
        const columns = db
          .prepare(`PRAGMA index_info(${index.name});`)
          .all()
          .map((row) => (row as { name: string }).name);
        return columns.join(",") === "repo_root,apply_id";
      }),
    ).toBe(true);
    expect(db.prepare("PRAGMA foreign_key_check;").all()).toEqual([]);
    expect(() => store.recoverInterruptedApplies()).not.toThrow();
    expect(store.listPendingContributions()).toEqual([]);
  });

  it("archives the pre-change payload ledger before the listModels startup query", () => {
    db.close();
    db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE self_mod_pending_change_sets (
        change_set_id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_self_mod_pending_repo_created
      ON self_mod_pending_change_sets(repo_root, created_at);
      INSERT INTO self_mod_pending_change_sets (
        change_set_id,
        repo_root,
        payload_json,
        created_at,
        updated_at
      ) VALUES (
        'legacy-change-set',
        '/repo/stella',
        '{"legacy":true}',
        10,
        20
      );

      -- A failed first launch of the newer build can already have created the
      -- empty child table before its worker-start query reaches the missing
      -- assistant_message_event_id column.
      CREATE TABLE self_mod_pending_contributions (
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

    initializeDesktopDatabase(db);
    store = new SelfModPendingStore(db, "/repo/stella");

    // These are the actual synchronous worker-initialization queries that
    // preferences:listModels reaches while ensuring the worker is available.
    expect(() => store.recoverInterruptedApplies()).not.toThrow();
    expect(store.listPendingContributions()).toEqual([]);

    expect(
      db
        .prepare(
          `SELECT payload_json
           FROM self_mod_pending_change_sets_legacy_v1
           WHERE change_set_id = ?`,
        )
        .get("legacy-change-set"),
    ).toEqual({ payload_json: '{"legacy":true}' });
    expect(
      db
        .prepare("PRAGMA foreign_key_list(self_mod_pending_contributions);")
        .all()
        .map((row) => (row as { table: string }).table),
    ).toContain("self_mod_pending_change_sets");
    expect(
      db
        .prepare("PRAGMA table_info(self_mod_pending_change_sets);")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual([
      "change_set_id",
      "repo_root",
      "conversation_id",
      "owner_thread_id",
      "completion_event_id",
      "assistant_message_event_id",
      "commit_hashes_json",
      "status",
      "created_at",
      "updated_at",
    ]);
    const migratedChangeSetIndexes = db
      .prepare("PRAGMA index_list(self_mod_pending_change_sets);")
      .all() as Array<{ name: string; unique: number }>;
    expect(
      migratedChangeSetIndexes.some((index) => {
        if (index.unique !== 1) return false;
        const columns = db
          .prepare(`PRAGMA index_info(${index.name});`)
          .all()
          .map((row) => (row as { name: string }).name);
        return columns.join(",") === "repo_root,completion_event_id";
      }),
    ).toBe(true);
    const migratedContributionIndexes = db
      .prepare("PRAGMA index_list(self_mod_pending_contributions);")
      .all() as Array<{ name: string; unique: number }>;
    expect(migratedContributionIndexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_self_mod_pending_unpublished_owner",
        "idx_self_mod_pending_change_set",
      ]),
    );
    expect(
      migratedContributionIndexes.some((index) => {
        if (index.unique !== 1) return false;
        const columns = db
          .prepare(`PRAGMA index_info(${index.name});`)
          .all()
          .map((row) => (row as { name: string }).name);
        return columns.join(",") === "repo_root,apply_id";
      }),
    ).toBe(true);
    expect(db.prepare("PRAGMA foreign_key_check;").all()).toEqual([]);

    store.stageContribution({
      applyId: "new-run",
      commitHash: "abc123",
      applyResult: applyResult("new-run"),
      conversationId: "conv-new",
      files: ["desktop/src/new-run.tsx"],
      ownerThreadId: "general-new",
    });
    expect(
      store.publishCompletion({
        conversationId: "conv-new",
        ownerThreadId: "general-new",
        completionEventId: "completion-new",
      }).changeSet,
    ).toMatchObject({
      changeSetId: "self-mod-change-set:completion-new",
      status: "published",
    });

    // Re-opening is idempotent: the current table remains active and the
    // archived legacy payload is neither duplicated nor discarded.
    expect(() => initializeDesktopDatabase(db)).not.toThrow();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM self_mod_pending_change_sets_legacy_v1;",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      new SelfModPendingStore(db, "/repo/stella").listPendingContributions(),
    ).toHaveLength(1);
  });

  it("rolls back without dropping legacy rows when an existing archive is incompatible", () => {
    db.close();
    db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
    db.exec(`
      CREATE TABLE self_mod_pending_change_sets (
        change_set_id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO self_mod_pending_change_sets VALUES (
        'legacy-change-set',
        '/repo/stella',
        '{"mustSurvive":true}',
        10,
        20
      );
      CREATE TABLE self_mod_pending_change_sets_legacy_v1 (
        change_set_id TEXT PRIMARY KEY
      );
    `);

    expect(() => initializeDesktopDatabase(db)).toThrow(
      "archive because its schema is incompatible",
    );
    expect(
      db
        .prepare(
          `SELECT payload_json
           FROM self_mod_pending_change_sets
           WHERE change_set_id = ?`,
        )
        .get("legacy-change-set"),
    ).toEqual({ payload_json: '{"mustSurvive":true}' });
  });

  it("rejects an unknown legacy source column without changing the source or archive", () => {
    db.close();
    db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
    db.exec(`
      CREATE TABLE self_mod_pending_change_sets (
        change_set_id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        recovery_note TEXT NOT NULL
      );
      INSERT INTO self_mod_pending_change_sets VALUES (
        'unknown-source-change-set',
        '/repo/stella',
        '{"mustSurvive":true}',
        10,
        20,
        'preserve this unknown field'
      );
      CREATE TABLE self_mod_pending_change_sets_legacy_v1 (
        change_set_id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        commit_hashes_json TEXT
      );
      INSERT INTO self_mod_pending_change_sets_legacy_v1 VALUES (
        'archive-change-set',
        '/repo/stella',
        '{"alreadyArchived":true}',
        1,
        2,
        '["archive-commit"]'
      );
    `);

    expect(() => initializeDesktopDatabase(db)).toThrow(
      "Cannot losslessly archive an unknown self_mod_pending_change_sets schema.",
    );
    expect(
      db
        .prepare(
          `SELECT payload_json, recovery_note
           FROM self_mod_pending_change_sets
           WHERE change_set_id = ?`,
        )
        .get("unknown-source-change-set"),
    ).toEqual({
      payload_json: '{"mustSurvive":true}',
      recovery_note: "preserve this unknown field",
    });
    expect(
      db
        .prepare(
          `SELECT payload_json, commit_hashes_json
           FROM self_mod_pending_change_sets_legacy_v1
           WHERE change_set_id = ?`,
        )
        .get("archive-change-set"),
    ).toEqual({
      payload_json: '{"alreadyArchived":true}',
      commit_hashes_json: '["archive-commit"]',
    });
    expect(
      db
        .prepare("PRAGMA table_info(self_mod_pending_change_sets);")
        .all()
        .map((row) => (row as { name: string }).name),
    ).toContain("recovery_note");
  });

  it("merges into an existing compatible archive and keeps the newer payload", () => {
    db.close();
    db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
    db.exec(`
      CREATE TABLE self_mod_pending_change_sets (
        change_set_id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO self_mod_pending_change_sets VALUES (
        'shared-change-set',
        '/repo/stella',
        '{"version":2}',
        10,
        20
      ), (
        'tie-change-set',
        '/repo/stella',
        '{"sourceOnTie":true}',
        30,
        30
      );
      CREATE TABLE self_mod_pending_change_sets_legacy_v1 (
        change_set_id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO self_mod_pending_change_sets_legacy_v1 VALUES
        ('shared-change-set', '/repo/stella', '{"version":1}', 10, 10),
        ('archive-only', '/repo/stella', '{"archived":true}', 5, 5),
        ('tie-change-set', '/repo/stella', '{"archiveWinsTie":true}', 30, 30);
    `);

    initializeDesktopDatabase(db);

    expect(
      db
        .prepare(
          `SELECT change_set_id, payload_json
           FROM self_mod_pending_change_sets_legacy_v1
           ORDER BY change_set_id`,
        )
        .all(),
    ).toEqual([
      {
        change_set_id: "archive-only",
        payload_json: '{"archived":true}',
      },
      { change_set_id: "shared-change-set", payload_json: '{"version":2}' },
      {
        change_set_id: "tie-change-set",
        payload_json: '{"archiveWinsTie":true}',
      },
    ]);
    expect(() =>
      new SelfModPendingStore(db, "/repo/stella").listPendingContributions(),
    ).not.toThrow();
  });

  it("rehydrates staged, published, and attached contributions in finalize order", () => {
    store.stageContribution({
      applyId: "child-run",
      commitHash: "abc123",
      applyResult: applyResult("child-run"),
      conversationId: "conv-1",
      files: ["desktop/src/child-run.tsx"],
      ownerThreadId: "general-1",
    });
    store.stageContribution({
      applyId: "parent-run",
      applyResult: applyResult("parent-run"),
      conversationId: "conv-1",
      files: ["desktop/src/parent-run.tsx"],
      ownerThreadId: "general-1",
    });

    const published = store.publishCompletion({
      conversationId: "conv-1",
      ownerThreadId: "general-1",
      completionEventId: "completion-1",
    });
    expect(published.changeSet.changeSetId).toBe(
      "self-mod-change-set:completion-1",
    );
    expect(published.contributions.map((entry) => entry.applyId)).toEqual([
      "child-run",
      "parent-run",
    ]);

    store.markAttached({
      completionEventId: "completion-1",
      assistantMessageEventId: "assistant-1",
    });

    const rehydrated = new SelfModPendingStore(
      db,
      "/repo/stella",
    ).listPendingContributions();
    expect(rehydrated.map((entry) => entry.applyId)).toEqual([
      "child-run",
      "parent-run",
    ]);
    expect(rehydrated[0]).toMatchObject({
      commitHash: "abc123",
      changeSetId: "self-mod-change-set:completion-1",
      completionEventId: "completion-1",
      assistantMessageEventId: "assistant-1",
      ownerThreadId: "general-1",
    });
    expect(rehydrated[0]?.applyResult).toEqual(applyResult("child-run"));
    expect(
      new SelfModPendingStore(db, "/repo/other").listPendingContributions(),
    ).toEqual([]);
  });

  it("fences completion replay so later contributions cannot join an old set", () => {
    store.stageContribution({
      applyId: "first-run",
      applyResult: applyResult("first-run"),
      conversationId: "conv-1",
      files: ["desktop/src/first-run.tsx"],
      ownerThreadId: "general-1",
    });
    const first = store.publishCompletion({
      conversationId: "conv-1",
      ownerThreadId: "general-1",
      completionEventId: "completion-1",
    });

    store.stageContribution({
      applyId: "later-run",
      applyResult: applyResult("later-run"),
      conversationId: "conv-1",
      files: ["desktop/src/later-run.tsx"],
      ownerThreadId: "general-1",
    });
    const replay = store.publishCompletion({
      conversationId: "conv-1",
      ownerThreadId: "general-1",
      completionEventId: "completion-1",
    });

    expect(replay.changeSet.changeSetId).toBe(first.changeSet.changeSetId);
    expect(replay.contributions.map((entry) => entry.applyId)).toEqual([
      "first-run",
    ]);
    expect(
      store
        .listPendingContributions()
        .find((entry) => entry.applyId === "later-run")?.changeSetId,
    ).toBeUndefined();
  });

  it("recovers an interrupted apply claim and deletes contributions only on success", () => {
    store.stageContribution({
      applyId: "run-1",
      commitHash: "abc123",
      applyResult: applyResult("run-1"),
      conversationId: "conv-1",
      files: ["desktop/src/run-1.tsx"],
      ownerThreadId: "general-1",
    });
    const published = store.publishCompletion({
      conversationId: "conv-1",
      ownerThreadId: "general-1",
      completionEventId: "completion-1",
    });
    store.markAttached({
      completionEventId: "completion-1",
      assistantMessageEventId: "assistant-1",
    });

    expect(
      store.beginApply({ applyId: published.changeSet.changeSetId })
        ?.contributions,
    ).toHaveLength(1);
    expect(
      store.beginApply({ applyId: published.changeSet.changeSetId }),
    ).toBeNull();

    const restartedStore = new SelfModPendingStore(db, "/repo/stella");
    restartedStore.recoverInterruptedApplies();
    const retry = restartedStore.beginApply({
      applyId: published.changeSet.changeSetId,
    });
    expect(retry?.contributions[0]?.applyResult).toEqual(applyResult("run-1"));

    restartedStore.completeApply(published.changeSet.changeSetId);
    expect(restartedStore.listPendingContributions()).toEqual([]);
    expect(
      restartedStore.beginApply({
        applyId: published.changeSet.changeSetId,
      }),
    ).toBeNull();
    expect(
      restartedStore.getChangeSet(published.changeSet.changeSetId),
    ).toMatchObject({
      status: "applied",
      assistantMessageEventId: "assistant-1",
      commitHashes: ["abc123"],
    });
  });

  it("retains the immutable exact commit set after applied contributions are deleted", () => {
    for (const [applyId, commitHash] of [
      ["run-1", "abc123"],
      ["run-2", "def456"],
    ] as const) {
      store.stageContribution({
        applyId,
        commitHash,
        applyResult: applyResult(applyId),
        conversationId: "conv-1",
        files: [`desktop/src/${applyId}.tsx`],
        ownerThreadId: "general-1",
      });
    }
    const published = store.publishCompletion({
      conversationId: "conv-1",
      ownerThreadId: "general-1",
      completionEventId: "completion-group",
    });

    expect(published.changeSet.commitHashes).toEqual(["abc123", "def456"]);
    store.completeApply(published.changeSet.changeSetId);
    expect(store.listPendingContributions()).toEqual([]);
    expect(store.getChangeSet(published.changeSet.changeSetId)).toMatchObject({
      status: "applied",
      commitHashes: ["abc123", "def456"],
    });
  });
});
