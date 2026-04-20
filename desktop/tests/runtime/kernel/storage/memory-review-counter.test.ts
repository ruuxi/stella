import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
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
    `stella-memory-review-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("memory-review user-turn counter", () => {
  it("starts at zero (returns 1 on the first increment)", () => {
    const { store } = createTestContext();
    const conversationId = "conv-1";
    expect(store.incrementUserTurnsSinceMemoryReview(conversationId)).toBe(1);
  });

  it("counts up monotonically across calls", () => {
    const { store } = createTestContext();
    const conversationId = "conv-monotonic";
    const observed: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      observed.push(store.incrementUserTurnsSinceMemoryReview(conversationId));
    }
    expect(observed).toEqual([1, 2, 3, 4, 5]);
  });

  it("is partitioned by conversationId", () => {
    const { store } = createTestContext();
    expect(store.incrementUserTurnsSinceMemoryReview("conv-a")).toBe(1);
    expect(store.incrementUserTurnsSinceMemoryReview("conv-b")).toBe(1);
    expect(store.incrementUserTurnsSinceMemoryReview("conv-a")).toBe(2);
    expect(store.incrementUserTurnsSinceMemoryReview("conv-b")).toBe(2);
    expect(store.incrementUserTurnsSinceMemoryReview("conv-a")).toBe(3);
  });

  it("reset returns the next increment to 1", () => {
    const { store } = createTestContext();
    const conversationId = "conv-reset";
    store.incrementUserTurnsSinceMemoryReview(conversationId);
    store.incrementUserTurnsSinceMemoryReview(conversationId);
    store.incrementUserTurnsSinceMemoryReview(conversationId);
    store.resetUserTurnsSinceMemoryReview(conversationId);
    expect(store.incrementUserTurnsSinceMemoryReview(conversationId)).toBe(1);
  });

  it("reset is idempotent and safe to call before any increment", () => {
    const { store } = createTestContext();
    const conversationId = "conv-reset-noop";
    store.resetUserTurnsSinceMemoryReview(conversationId);
    store.resetUserTurnsSinceMemoryReview(conversationId);
    expect(store.incrementUserTurnsSinceMemoryReview(conversationId)).toBe(1);
  });

  it("reaches the documented threshold (20) after 20 increments", () => {
    const { store } = createTestContext();
    const conversationId = "conv-threshold";
    let last = 0;
    for (let i = 0; i < 20; i += 1) {
      last = store.incrementUserTurnsSinceMemoryReview(conversationId);
    }
    expect(last).toBe(20);
  });
});
