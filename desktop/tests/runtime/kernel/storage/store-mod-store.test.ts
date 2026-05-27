import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";
import { StoreModStore } from "../../../../../runtime/kernel/storage/store-mod-store.js";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: StoreModStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-store-mod-store-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = {
    rootPath,
    db,
    store: new StoreModStore(db),
  };
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

describe("StoreModStore", () => {
  it("keeps install commit and Stella source revision chains together", () => {
    const { store } = createTestContext();

    const first = store.recordInstall({
      packageId: "quiet-mode",
      releaseNumber: 1,
      installCommitHash: "a".repeat(40),
      sourceRevisionId: "sha256:first",
      installedAt: 1_000,
    });
    expect(first.installCommitHashes).toEqual(["a".repeat(40)]);
    expect(first.sourceRevisionIds).toEqual(["sha256:first"]);

    const second = store.recordInstall({
      packageId: "quiet-mode",
      releaseNumber: 2,
      installCommitHash: "b".repeat(40),
      sourceRevisionId: "sha256:second",
      installedAt: 2_000,
    });

    expect(second).toMatchObject({
      packageId: "quiet-mode",
      releaseNumber: 2,
      installCommitHash: "b".repeat(40),
      sourceRevisionId: "sha256:second",
      installCommitHashes: ["a".repeat(40), "b".repeat(40)],
      sourceRevisionIds: ["sha256:first", "sha256:second"],
    });
    expect(store.getInstall("quiet-mode")).toMatchObject({
      installCommitHashes: ["a".repeat(40), "b".repeat(40)],
      sourceRevisionIds: ["sha256:first", "sha256:second"],
    });
  });

  it("preserves the latest install commit when a Store source revision update is already applied", () => {
    const { store } = createTestContext();

    store.recordInstall({
      packageId: "quiet-mode",
      releaseNumber: 1,
      installCommitHash: "a".repeat(40),
      sourceRevisionId: "sha256:first",
      installedAt: 1_000,
    });

    const update = store.recordInstall({
      packageId: "quiet-mode",
      releaseNumber: 2,
      installCommitHash: null,
      sourceRevisionId: "sha256:second",
      installedAt: 2_000,
    });

    expect(update).toMatchObject({
      packageId: "quiet-mode",
      releaseNumber: 2,
      installCommitHash: "a".repeat(40),
      sourceRevisionId: "sha256:second",
      installCommitHashes: ["a".repeat(40)],
      sourceRevisionIds: ["sha256:first", "sha256:second"],
    });
    expect(store.getInstall("quiet-mode")).toMatchObject({
      installCommitHash: "a".repeat(40),
      sourceRevisionId: "sha256:second",
      installCommitHashes: ["a".repeat(40)],
      sourceRevisionIds: ["sha256:first", "sha256:second"],
    });
  });

  it("records both author and local source revision ids for conflict-resolved installs", () => {
    const { store } = createTestContext();

    const install = store.recordInstall({
      packageId: "quiet-mode",
      releaseNumber: 1,
      installCommitHash: "a".repeat(40),
      sourceRevisionId: "sha256:local-resolution",
      sourceRevisionIds: ["sha256:author-release"],
      installedAt: 1_000,
    });

    expect(install).toMatchObject({
      packageId: "quiet-mode",
      releaseNumber: 1,
      installCommitHash: "a".repeat(40),
      sourceRevisionId: "sha256:local-resolution",
      sourceRevisionIds: ["sha256:author-release", "sha256:local-resolution"],
    });
    expect(store.getInstall("quiet-mode")).toMatchObject({
      sourceRevisionId: "sha256:local-resolution",
      sourceRevisionIds: ["sha256:author-release", "sha256:local-resolution"],
    });
  });
});
