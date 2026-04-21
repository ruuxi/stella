import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  dreamList,
  dreamMarkProcessed,
} from "../../../../../runtime/kernel/memory/dream-core.js";
import { ThreadSummariesStore } from "../../../../../runtime/kernel/memory/thread-summaries-store.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: ThreadSummariesStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-dream-core-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, { timeout: 5_000 }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = {
    rootPath,
    db,
    store: new ThreadSummariesStore(db),
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

describe("dream-core", () => {
  it("does not skip same-timestamp thread summaries after partial processing", async () => {
    const { db, rootPath, store } = createTestContext();

    store.record({
      threadId: "thread-a",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "First summary",
    });
    store.record({
      threadId: "thread-b",
      runId: "run-2",
      agentType: "general",
      rolloutSummary: "Second summary",
    });
    store.record({
      threadId: "thread-c",
      runId: "run-3",
      agentType: "general",
      rolloutSummary: "Third summary",
    });

    db.prepare("UPDATE thread_summaries SET source_updated_at = ?").run(1_700_000_000_000);

    await dreamMarkProcessed({
      stellaHome: rootPath,
      store,
      threadKeys: [
        { threadId: "thread-a", runId: "run-1" },
        { threadId: "thread-b", runId: "run-2" },
      ],
    });

    const result = await dreamList({ stellaHome: rootPath, store });
    expect(result.threadSummaries.map((entry) => entry.runId)).toEqual(["run-3"]);
  });

  it("tracks processed extension files individually", async () => {
    const { rootPath, store } = createTestContext();
    const extensionDir = path.join(
      rootPath,
      "state",
      "memories_extensions",
      "chronicle",
    );
    await mkdir(extensionDir, { recursive: true });

    const instructionsPath = path.join(extensionDir, "instructions.md");
    const firstPath = path.join(extensionDir, "2026-04-18-a.md");
    const secondPath = path.join(extensionDir, "2026-04-18-b.md");
    await writeFile(instructionsPath, "# Chronicle instructions\n", "utf-8");
    await writeFile(firstPath, "# A\n", "utf-8");
    await writeFile(secondPath, "# B\n", "utf-8");

    const sameTimestamp = new Date("2026-04-18T12:00:00.000Z");
    await utimes(firstPath, sameTimestamp, sameTimestamp);
    await utimes(secondPath, sameTimestamp, sameTimestamp);

    await dreamMarkProcessed({
      stellaHome: rootPath,
      store,
      extensionPaths: [firstPath],
    });

    const result = await dreamList({ stellaHome: rootPath, store });
    expect(result.extensions.map((entry) => entry.path)).toEqual([secondPath]);
  });
});
