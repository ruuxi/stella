import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dreamList,
  dreamMarkProcessed,
} from "../../../../../runtime/kernel/memory/dream-core.js";
import { ThreadSummariesStore } from "../../../../../runtime/kernel/memory/thread-summaries-store.js";
import { createSqliteTestContextFactory } from "../../../helpers/sqlite-test-context.js";

const testContexts = createSqliteTestContextFactory(
  "stella-dream-core",
  (db) => new ThreadSummariesStore(db),
);
const createTestContext = testContexts.create;

afterEach(() => testContexts.cleanup());

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

    db.prepare("UPDATE thread_summaries SET source_updated_at = ?").run(
      1_700_000_000_000,
    );

    await dreamMarkProcessed({
      stellaHome: rootPath,
      store,
      threadKeys: [
        { threadId: "thread-a", runId: "run-1" },
        { threadId: "thread-b", runId: "run-2" },
      ],
    });

    const result = await dreamList({ stellaHome: rootPath, store });
    expect(result.threadSummaries.map((entry) => entry.runId)).toEqual([
      "run-3",
    ]);
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
