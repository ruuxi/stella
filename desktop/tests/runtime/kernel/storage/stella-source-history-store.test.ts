import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStellaSourceChangeSetFromTrees,
  hashSourceTree,
  type StellaSourceTree,
} from "../../../../../runtime/kernel/self-mod/stella-source-control.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";
import { StellaSourceHistoryStore } from "../../../../../runtime/kernel/storage/stella-source-history-store.js";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: StellaSourceHistoryStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-source-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = {
    rootPath,
    db,
    store: new StellaSourceHistoryStore(db),
  };
  activeContexts.add(context);
  return context;
};

const text = (content: string) => ({ kind: "text" as const, content });

afterEach(async () => {
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

describe("StellaSourceHistoryStore", () => {
  it("persists hash-only source revisions keyed by commit and feature", () => {
    const { store } = createTestContext();
    const baseTree: StellaSourceTree = {
      "src/panel.ts": text("base\n"),
    };
    const nextTree: StellaSourceTree = {
      "src/panel.ts": text("next\n"),
    };
    const changeSet = createStellaSourceChangeSetFromTrees({
      baseRevisionId: hashSourceTree(baseTree),
      baseTree,
      nextTree,
      featureId: "self-mod:conv-1",
      description: "Panel copy",
    });

    const record = store.recordRevision({
      changeSet,
      origin: "self-mod",
      commitHash: "a".repeat(40),
      featureId: "self-mod:conv-1",
      description: "Panel copy",
      createdAt: 1_000,
    });

    expect(record.revisionId).toBe(changeSet.revisionId);
    expect(record.changeSet.changes[0]).not.toHaveProperty("base");
    expect(record.changeSet.changes[0]).not.toHaveProperty("next");
    expect(store.findRevisionByCommit("a".repeat(40))?.revisionId).toBe(
      changeSet.revisionId,
    );
    expect(
      store.listFeatureRevisions("self-mod:conv-1").map((entry) => ({
        revisionId: entry.revisionId,
        origin: entry.origin,
      })),
    ).toEqual([{ revisionId: changeSet.revisionId, origin: "self-mod" }]);
  });

  it("keeps commit aliases when the same source revision is recorded again", () => {
    const { store } = createTestContext();
    const baseTree: StellaSourceTree = {
      "src/update.ts": text("base\n"),
    };
    const nextTree: StellaSourceTree = {
      "src/update.ts": text("next\n"),
    };
    const changeSet = createStellaSourceChangeSetFromTrees({
      baseRevisionId: hashSourceTree(baseTree),
      baseTree,
      nextTree,
      featureId: "desktop-release",
      description: "Desktop release v2",
    });
    const localCommit = "b".repeat(40);
    const upstreamCommit = "c".repeat(40);

    store.recordRevision({
      changeSet,
      origin: "desktop-update",
      commitHash: localCommit,
      createdAt: 1_000,
    });
    store.recordRevision({
      changeSet,
      origin: "official",
      commitHash: upstreamCommit,
      createdAt: 2_000,
    });

    expect(store.findRevisionByCommit(localCommit)?.revisionId).toBe(
      changeSet.revisionId,
    );
    expect(store.findRevisionByCommit(upstreamCommit)).toMatchObject({
      revisionId: changeSet.revisionId,
      origin: "official",
      commitHash: upstreamCommit,
    });
  });
});
