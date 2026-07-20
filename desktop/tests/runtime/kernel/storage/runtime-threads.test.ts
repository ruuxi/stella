import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ACTIVE_RUNTIME_THREADS,
  buildActiveThreadsPrompt,
  type RuntimeThreadRecord,
} from "../../../../../runtime/kernel/runtime-threads.js";
import { slugify } from "../../../../../runtime/kernel/shared/slug.js";
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
    `stella-runtime-threads-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = { rootPath, db, store: new SessionStore(db) };
  activeContexts.add(context);
  return context;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-11T12:00:00Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

const spawnThread = (
  store: SessionStore,
  conversationId: string,
  nameHint: string,
) => {
  vi.advanceTimersByTime(1_000);
  return store.resolveOrCreateActiveThread({
    conversationId,
    agentType: "general",
    nameHint,
  });
};

const threadStatus = (db: SqliteDatabase, threadId: string): string =>
  (
    db
      .prepare("SELECT status FROM runtime_threads WHERE thread_key = ?")
      .get(threadId) as { status: string }
  ).status;

describe("slugify", () => {
  it("normalizes phrases and diacritics", () => {
    expect(slugify("Compare Flight Prices: Tokyo!")).toBe(
      "compare-flight-prices-tokyo",
    );
    expect(slugify("Café au Lait — Crème Brûlée")).toBe(
      "cafe-au-lait-creme-brulee",
    );
    expect(slugify("🔥🚀 ✨")).toBe("");
  });

  it("truncates at a word boundary", () => {
    const slug = slugify(
      "Compare international flight prices Tokyo Osaka Kyoto",
    );
    expect(slug).toBe("compare-international-flight-prices-tokyo-osaka");
    expect(slug.length).toBeLessThanOrEqual(48);
  });
});

describe("durable thread naming", () => {
  it("mints readable unique thread ids and preserves the display name", () => {
    const { store } = createTestContext();
    const first = spawnThread(store, "conv-naming", "Compare flight prices");
    const second = spawnThread(store, "conv-naming", "Compare flight prices");
    expect(first.threadId).toBe("compare-flight-prices");
    expect(second.threadId).toBe("compare-flight-prices-2");
    expect(
      store
        .listActiveThreads("conv-naming")
        .find((thread) => thread.threadId === first.threadId)?.name,
    ).toBe("Compare flight prices");
  });

  it("uses task ordinals when a description cannot produce a safe slug", () => {
    const { store } = createTestContext();
    expect(spawnThread(store, "conv-fallback", "🔥🚀✨").threadId).toBe(
      "task-1",
    );
    expect(
      spawnThread(store, "conv-fallback", "Legacy data import").threadId,
    ).toBe("task-2");
  });

  it("allows ordinary grp-prefixed descriptions now that groups do not exist", () => {
    const { store } = createTestContext();
    expect(spawnThread(store, "conv-grp", "GRP rollout plan").threadId).toBe(
      "grp-rollout-plan",
    );
  });
});

describe("per-thread active budget", () => {
  it("evicts only the least-recently-used thread when the cap is exceeded", () => {
    const { db, store } = createTestContext();
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS; i += 1) {
      ids.push(spawnThread(store, "conv-evict", `Task ${i}`).threadId);
    }
    const overflow = spawnThread(store, "conv-evict", "Overflow task");
    const active = store
      .listActiveThreads("conv-evict")
      .map((thread) => thread.threadId);
    expect(active).toHaveLength(MAX_ACTIVE_RUNTIME_THREADS);
    expect(active).not.toContain(ids[0]);
    expect(active).toContain(ids[1]);
    expect(active).toContain(overflow.threadId);
    expect(threadStatus(db, ids[0]!)).toBe("evicted");
  });

  it("reactivates one evicted thread and evicts one active thread", () => {
    const { db, store } = createTestContext();
    const oldest = spawnThread(store, "conv-resume", "Old work");
    const fillers: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS; i += 1) {
      fillers.push(spawnThread(store, "conv-resume", `Filler ${i}`).threadId);
    }
    expect(threadStatus(db, oldest.threadId)).toBe("evicted");
    const resumed = store.resolveOrCreateActiveThread({
      conversationId: "conv-resume",
      agentType: "general",
      threadId: oldest.threadId,
    });
    expect(resumed).toEqual({ threadId: oldest.threadId, reused: true });
    expect(threadStatus(db, oldest.threadId)).toBe("active");
    expect(threadStatus(db, fillers[0]!)).toBe("evicted");
  });
});

describe("buildActiveThreadsPrompt", () => {
  const thread = (
    overrides: Partial<RuntimeThreadRecord> & { threadId: string },
  ): RuntimeThreadRecord => ({
    conversationId: "conv-prompt",
    name: overrides.threadId,
    agentType: "general",
    status: "active",
    createdAt: 0,
    lastUsedAt: 0,
    ...overrides,
  });

  it("renders a flat, recency-ordered thread roster with live status", () => {
    const now = 1_700_000_000_000;
    const prompt = buildActiveThreadsPrompt(
      [
        thread({
          threadId: "running-now",
          lastUsedAt: now - 10 * 60_000,
          agentUpdatedAt: now - 60_000,
          agentStatus: "running",
        }),
        thread({
          threadId: "idle-thread",
          lastUsedAt: now - 5 * 60_000,
          agentStatus: "completed",
        }),
        thread({
          threadId: "errored-thread",
          lastUsedAt: now - 2 * 60_000,
          agentStatus: "error",
        }),
      ],
      now,
    );
    expect(prompt.indexOf("running-now")).toBeLessThan(
      prompt.indexOf("errored-thread"),
    );
    expect(prompt).toContain("- running-now (active, last active 1m ago)");
    expect(prompt).toContain("- idle-thread (paused, last active 5m ago)");
    expect(prompt).toContain(
      "- errored-thread (paused (last run errored), last active 2m ago)",
    );
    expect(prompt).not.toContain("grp-…");
  });

  it("derives status from the persisted runtime agent row", () => {
    const { store } = createTestContext();
    const running = spawnThread(store, "conv-live", "Deploy backend");
    const at = Date.now();
    store.saveAgentRecord({
      threadId: running.threadId,
      conversationId: "conv-live",
      agentType: "general",
      description: "Deploy backend",
      agentDepth: 1,
      status: "running",
      startedAt: at,
      completedAt: null,
      updatedAt: at,
    });
    expect(
      buildActiveThreadsPrompt(store.listActiveThreads("conv-live"), at),
    ).toContain(`- ${running.threadId} (active, last active`);
  });

  it("returns an empty string when no threads are active", () => {
    expect(buildActiveThreadsPrompt([], 1_700_000_000_000)).toBe("");
  });
});

describe("thread search exclusions", () => {
  it("does not expose implicit subagent transcript rows", () => {
    const { store } = createTestContext();
    spawnThread(store, "conv-search", "Real flight research");
    store.updateThreadSummary(
      "conv-search::subagent::general::wf-research-a1",
      "internal transcript",
    );
    expect(
      store
        .searchThreads({ conversationId: "conv-search" })
        .map((entry) => entry.threadId),
    ).toEqual(["real-flight-research"]);
  });
});
