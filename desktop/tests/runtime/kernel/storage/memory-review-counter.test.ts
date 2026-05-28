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

describe("memory-review watermark (last reviewed message timestamp)", () => {
  it("defaults to zero before any review", () => {
    const { store } = createTestContext();
    expect(store.getMemoryReviewState("conv-fresh")).toEqual({
      userTurnsSinceReview: 0,
      lastReviewedMessageTs: 0,
    });
  });

  it("advances the watermark on reset and resets the counter", () => {
    const { store } = createTestContext();
    const conversationId = "conv-watermark";
    store.incrementUserTurnsSinceMemoryReview(conversationId);
    store.incrementUserTurnsSinceMemoryReview(conversationId);

    store.resetUserTurnsSinceMemoryReview(conversationId, 1734_000_000_000);

    expect(store.getMemoryReviewState(conversationId)).toEqual({
      userTurnsSinceReview: 0,
      lastReviewedMessageTs: 1734_000_000_000,
    });
  });

  it("preserves the existing watermark when reset is called without one", () => {
    const { store } = createTestContext();
    const conversationId = "conv-preserve";
    store.resetUserTurnsSinceMemoryReview(conversationId, 500);
    store.incrementUserTurnsSinceMemoryReview(conversationId);

    store.resetUserTurnsSinceMemoryReview(conversationId);

    expect(store.getMemoryReviewState(conversationId)).toEqual({
      userTurnsSinceReview: 0,
      lastReviewedMessageTs: 500,
    });
  });

  it("does not regress the watermark when increments happen between reviews", () => {
    const { store } = createTestContext();
    const conversationId = "conv-advance";
    store.resetUserTurnsSinceMemoryReview(conversationId, 100);
    store.incrementUserTurnsSinceMemoryReview(conversationId);
    expect(store.getMemoryReviewState(conversationId).lastReviewedMessageTs).toBe(
      100,
    );
    store.resetUserTurnsSinceMemoryReview(conversationId, 250);
    expect(store.getMemoryReviewState(conversationId).lastReviewedMessageTs).toBe(
      250,
    );
  });
});

describe("memory-review watermark advance (post-completion)", () => {
  it("advances the watermark without resetting the user-turn counter", () => {
    const { store } = createTestContext();
    const conversationId = "conv-advance-only";
    store.incrementUserTurnsSinceMemoryReview(conversationId);
    store.incrementUserTurnsSinceMemoryReview(conversationId);

    store.advanceMemoryReviewWatermark(conversationId, 1734_000_000_000);

    expect(store.getMemoryReviewState(conversationId)).toEqual({
      userTurnsSinceReview: 2,
      lastReviewedMessageTs: 1734_000_000_000,
    });
  });

  it("never regresses an existing watermark", () => {
    const { store } = createTestContext();
    const conversationId = "conv-advance-noregress";
    store.advanceMemoryReviewWatermark(conversationId, 500);
    store.advanceMemoryReviewWatermark(conversationId, 250);
    expect(
      store.getMemoryReviewState(conversationId).lastReviewedMessageTs,
    ).toBe(500);
  });

  it("ignores non-positive timestamps", () => {
    const { store } = createTestContext();
    const conversationId = "conv-advance-zero";
    store.advanceMemoryReviewWatermark(conversationId, 0);
    expect(
      store.getMemoryReviewState(conversationId).lastReviewedMessageTs,
    ).toBe(0);
  });
});
