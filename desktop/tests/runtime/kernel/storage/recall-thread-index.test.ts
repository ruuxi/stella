// Rows behind Recall's inline "# Thread Index": the most recent N delegated
// agent threads across ALL conversations with the fields the index renders —
// including the agent's final result/error excerpts, which no keyword search
// ever exposed (and `summary` is empty on nearly every real thread).

import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    `stella-recall-index-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

afterEach(async () => {
  vi.useRealTimers();
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

const createThreadAt = (
  store: SessionStore,
  atMs: number,
  args: { conversationId: string; agentType?: string; nameHint: string },
): string => {
  vi.setSystemTime(atMs);
  const { threadId } = store.resolveOrCreateActiveThread({
    conversationId: args.conversationId,
    agentType: args.agentType ?? "general",
    nameHint: args.nameHint,
  });
  return threadId;
};

describe("listThreadsForRecallIndex", () => {
  it("returns threads across ALL conversations with agent result/error excerpts", () => {
    const { store } = createTestContext();
    vi.useFakeTimers();
    const t1 = createThreadAt(store, 1_000, {
      conversationId: "conv-a",
      nameHint: "Deploy the backend",
    });
    const t2 = createThreadAt(store, 2_000, {
      conversationId: "conv-b",
      nameHint: "Draft the budget",
    });
    store.saveAgentRecord({
      threadId: t1,
      conversationId: "conv-a",
      agentType: "general",
      description: "Deploy the backend to prod",
      agentDepth: 0,
      status: "completed",
      startedAt: 1_000,
      completedAt: 5_000,
      result: "Deployed rev 42 to prod.",
      updatedAt: 5_000,
    });
    store.saveAgentRecord({
      threadId: t2,
      conversationId: "conv-b",
      agentType: "general",
      description: "Draft the budget",
      agentDepth: 0,
      status: "error",
      startedAt: 2_000,
      completedAt: 3_000,
      error: "spreadsheet API returned 401",
      updatedAt: 3_000,
    });

    const rows = store.listThreadsForRecallIndex({ limit: 10 });
    expect(rows.map((row) => row.threadId)).toEqual([t1, t2]);
    const deploy = rows.find((row) => row.threadId === t1);
    expect(deploy?.resultExcerpt).toBe("Deployed rev 42 to prod.");
    expect(deploy?.agentStatus).toBe("completed");
    expect(deploy?.agentUpdatedAt).toBe(5_000);
    const budget = rows.find((row) => row.threadId === t2);
    expect(budget?.errorExcerpt).toBe("spreadsheet API returned 401");
    expect(budget?.resultExcerpt).toBeUndefined();
  });

  it("selects the most recent by genuine last-active (agent updates count) and honors the limit", () => {
    const { store } = createTestContext();
    vi.useFakeTimers();
    const oldButBusy = createThreadAt(store, 1_000, {
      conversationId: "conv-a",
      nameHint: "Old thread still working",
    });
    createThreadAt(store, 2_000, {
      conversationId: "conv-a",
      nameHint: "Middle thread",
    });
    const newest = createThreadAt(store, 3_000, {
      conversationId: "conv-a",
      nameHint: "Newest thread",
    });
    // The old thread's agent record was touched most recently — a running
    // turn bumps updated_at even when the thread row wasn't re-used.
    store.saveAgentRecord({
      threadId: oldButBusy,
      conversationId: "conv-a",
      agentType: "general",
      description: "Old thread still working",
      agentDepth: 0,
      status: "running",
      startedAt: 1_000,
      completedAt: null,
      updatedAt: 9_000,
    });

    const rows = store.listThreadsForRecallIndex({ limit: 2 });
    expect(rows.map((row) => row.threadId)).toEqual([oldButBusy, newest]);
  });

  it("excludes orchestrator threads and truncates oversized results", () => {
    const { store } = createTestContext();
    vi.useFakeTimers();
    createThreadAt(store, 1_000, {
      conversationId: "conv-a",
      agentType: "orchestrator",
      nameHint: "The conversation itself",
    });
    const worker = createThreadAt(store, 2_000, {
      conversationId: "conv-a",
      nameHint: "Real delegated work",
    });
    store.saveAgentRecord({
      threadId: worker,
      conversationId: "conv-a",
      agentType: "general",
      description: "Real delegated work",
      agentDepth: 0,
      status: "completed",
      startedAt: 2_000,
      completedAt: 3_000,
      result: "x".repeat(5_000),
      updatedAt: 3_000,
    });

    const rows = store.listThreadsForRecallIndex({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadId).toBe(worker);
    expect(rows[0]?.resultExcerpt?.length).toBe(400);
  });

  it("drops threads whose last activity predates activeSinceMs", () => {
    const { store } = createTestContext();
    vi.useFakeTimers();
    const stale = createThreadAt(store, 1_000, {
      conversationId: "conv-a",
      nameHint: "Stale thread",
    });
    const fresh = createThreadAt(store, 9_000, {
      conversationId: "conv-a",
      nameHint: "Fresh thread",
    });
    // A stale thread whose AGENT record was recently updated stays in the
    // window — last activity is the max of thread and agent recency.
    const staleButBusy = createThreadAt(store, 2_000, {
      conversationId: "conv-b",
      nameHint: "Stale but busy",
    });
    store.saveAgentRecord({
      threadId: staleButBusy,
      conversationId: "conv-b",
      agentType: "general",
      description: "Stale but busy",
      agentDepth: 0,
      status: "running",
      startedAt: 2_000,
      completedAt: null,
      updatedAt: 8_000,
    });

    const rows = store.listThreadsForRecallIndex({
      limit: 10,
      activeSinceMs: 5_000,
    });
    expect(rows.map((row) => row.threadId).sort()).toEqual(
      [fresh, staleButBusy].sort(),
    );
    expect(rows.map((row) => row.threadId)).not.toContain(stale);
  });
});

describe("countThreadsCreatedSince", () => {
  it("counts only index-eligible threads created at or after the cutoff", () => {
    const { store } = createTestContext();
    vi.useFakeTimers();
    createThreadAt(store, 1_000, {
      conversationId: "conv-a",
      nameHint: "Too old to count",
    });
    createThreadAt(store, 5_000, {
      conversationId: "conv-a",
      nameHint: "Recent one",
    });
    createThreadAt(store, 6_000, {
      conversationId: "conv-b",
      agentType: "orchestrator",
      nameHint: "Orchestrator thread never counts",
    });
    expect(store.countThreadsCreatedSince(4_000)).toBe(1);
    expect(store.countThreadsCreatedSince(0)).toBe(2);
  });
});
