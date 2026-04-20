import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import { buildMemoryReviewSystemPrompt } from "../../../../../runtime/kernel/agent-runtime/memory-review.js";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
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
    `stella-memory-review-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, { timeout: 5000 }) as unknown as SqliteDatabase;
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

describe("buildMemoryReviewSystemPrompt", () => {
  it("includes the current durable memory snapshot", () => {
    const { store } = createTestContext();
    store.memoryStore.add("user", "User prefers terse replies");

    const prompt = buildMemoryReviewSystemPrompt(store as never);

    expect(prompt).toContain("Current durable memory snapshot for this review:");
    expect(prompt).toContain('<memory_snapshot target="user">');
    expect(prompt).toContain("User prefers terse replies");
  });

  it("refreshes the snapshot on each call so new writes are visible", () => {
    const { store } = createTestContext();
    store.memoryStore.add("memory", "Initial cross-task pattern");
    const before = buildMemoryReviewSystemPrompt(store as never);

    store.memoryStore.add("memory", "Freshly learned pattern");
    const after = buildMemoryReviewSystemPrompt(store as never);

    expect(before).toContain("Initial cross-task pattern");
    expect(before).not.toContain("Freshly learned pattern");
    expect(after).toContain("Freshly learned pattern");
  });
});
