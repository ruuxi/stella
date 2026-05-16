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
import { MEMORY_INJECTION_TURN_THRESHOLD } from "../../../../../runtime/extensions/stella-runtime/hooks/memory-injection.hook.js";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-memory-injection-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("memory-injection user-turn counter", () => {
  it("starts at zero (returns 1 on the first increment)", () => {
    const { store } = createTestContext();
    expect(store.incrementUserTurnsSinceMemoryInjection("conv-1")).toBe(1);
  });

  it("counts up monotonically across calls", () => {
    const { store } = createTestContext();
    const observed: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      observed.push(store.incrementUserTurnsSinceMemoryInjection("conv-mono"));
    }
    expect(observed).toEqual([1, 2, 3, 4, 5]);
  });

  it("is partitioned by conversationId", () => {
    const { store } = createTestContext();
    expect(store.incrementUserTurnsSinceMemoryInjection("conv-a")).toBe(1);
    expect(store.incrementUserTurnsSinceMemoryInjection("conv-b")).toBe(1);
    expect(store.incrementUserTurnsSinceMemoryInjection("conv-a")).toBe(2);
    expect(store.incrementUserTurnsSinceMemoryInjection("conv-b")).toBe(2);
  });

  it("reset rolls the counter back to 1 (this turn just injected)", () => {
    const { store } = createTestContext();
    const conversationId = "conv-reset";
    store.incrementUserTurnsSinceMemoryInjection(conversationId);
    store.incrementUserTurnsSinceMemoryInjection(conversationId);
    store.incrementUserTurnsSinceMemoryInjection(conversationId);
    store.resetUserTurnsSinceMemoryInjection(conversationId);
    expect(store.incrementUserTurnsSinceMemoryInjection(conversationId)).toBe(2);
  });

  it("re-injects on turn 1 then every Nth turn after", () => {
    const { store } = createTestContext();
    const conversationId = "conv-cadence";
    const injectAtTurn: number[] = [];
    for (let turn = 1; turn <= MEMORY_INJECTION_TURN_THRESHOLD * 3 + 5; turn += 1) {
      const counter = store.incrementUserTurnsSinceMemoryInjection(conversationId);
      const shouldInject =
        counter === 1 || counter > MEMORY_INJECTION_TURN_THRESHOLD;
      if (shouldInject) {
        injectAtTurn.push(turn);
        if (counter > 1) {
          store.resetUserTurnsSinceMemoryInjection(conversationId);
        }
      }
    }
    const N = MEMORY_INJECTION_TURN_THRESHOLD;
    expect(injectAtTurn).toEqual([1, N + 1, 2 * N + 1, 3 * N + 1]);
  });
});
