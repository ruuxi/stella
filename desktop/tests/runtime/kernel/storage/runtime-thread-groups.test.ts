import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ACTIVE_RUNTIME_THREADS,
  MAX_GROUP_MEMBER_THREADS,
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
    `stella-thread-groups-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = {
    rootPath,
    db,
    store: new SessionStore(db),
  };
  activeContexts.add(context);
  return context;
};

beforeEach(() => {
  // last_used_at is driven by Date.now(); slot eviction picks the slot
  // whose MAX(last_used_at) is smallest, so tests advance fake time
  // between spawns to make LRU ordering deterministic.
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

/** Spawn a new general thread, advancing fake time so recency ordering is strict. */
const spawnThread = (
  store: SessionStore,
  conversationId: string,
  nameHint: string,
  group?: string,
) => {
  vi.advanceTimersByTime(1_000);
  return store.resolveOrCreateActiveThread({
    conversationId,
    agentType: "general",
    nameHint,
    ...(group ? { group } : {}),
  });
};

const threadStatus = (db: SqliteDatabase, threadId: string): string =>
  (
    db
      .prepare("SELECT status FROM runtime_threads WHERE thread_key = ?")
      .get(threadId) as { status: string }
  ).status;

const activeThreadIds = (
  store: SessionStore,
  conversationId: string,
): string[] =>
  store.listActiveThreads(conversationId).map((thread) => thread.threadId);

describe("slugify", () => {
  it("slugs a basic phrase to lowercase dash-separated words", () => {
    expect(slugify("Compare Flight Prices: Tokyo!")).toBe(
      "compare-flight-prices-tokyo",
    );
  });

  it("strips diacritics", () => {
    expect(slugify("Café au Lait — Crème Brûlée")).toBe(
      "cafe-au-lait-creme-brulee",
    );
  });

  it("returns an empty string for emoji-only input", () => {
    expect(slugify("🔥🚀 ✨")).toBe("");
  });

  it("truncates long input at a word boundary", () => {
    const slug = slugify(
      "Compare international flight prices Tokyo Osaka Kyoto",
    );
    // Full slug is 53 chars; the 48-char cut lands on the dash after
    // "osaka", so "kyoto" is dropped whole rather than mid-word.
    expect(slug).toBe("compare-international-flight-prices-tokyo-osaka");
    expect(slug.length).toBeLessThanOrEqual(48);
  });

  it("honors a custom maxLength, cutting back to the previous word", () => {
    expect(slugify("alpha beta gamma", 12)).toBe("alpha-beta");
  });
});

describe("slug-based thread naming", () => {
  it("mints the thread key from the nameHint slug and stores the hint as name", () => {
    const { store } = createTestContext();
    const conversationId = "conv-naming";
    const result = spawnThread(
      store,
      conversationId,
      "Compare flight prices Tokyo",
    );
    expect(result.threadId).toBe("compare-flight-prices-tokyo");
    expect(result.reused).toBe(false);
    const record = store
      .listActiveThreads(conversationId)
      .find((thread) => thread.threadId === result.threadId);
    expect(record?.name).toBe("Compare flight prices Tokyo");
  });

  it("collapses whitespace in the stored name", () => {
    const { store } = createTestContext();
    const conversationId = "conv-naming-ws";
    const result = spawnThread(
      store,
      conversationId,
      "  Compare   flight\tprices  ",
    );
    expect(result.threadId).toBe("compare-flight-prices");
    const record = store
      .listActiveThreads(conversationId)
      .find((thread) => thread.threadId === result.threadId);
    expect(record?.name).toBe("Compare flight prices");
  });

  it("suffixes colliding thread keys with -2, -3", () => {
    const { store } = createTestContext();
    const conversationId = "conv-collide";
    const first = spawnThread(store, conversationId, "Compare flight prices");
    const second = spawnThread(store, conversationId, "Compare flight prices");
    const third = spawnThread(store, conversationId, "Compare flight prices");
    expect(first.threadId).toBe("compare-flight-prices");
    expect(second.threadId).toBe("compare-flight-prices-2");
    expect(third.threadId).toBe("compare-flight-prices-3");
  });

  it("falls back to task-N ordinals when the hint slugs to nothing", () => {
    const { store } = createTestContext();
    const conversationId = "conv-emoji";
    const first = spawnThread(store, conversationId, "🔥🚀✨");
    const second = spawnThread(store, conversationId, "💡");
    expect(first.threadId).toBe("task-1");
    expect(second.threadId).toBe("task-2");
    // The display name still keeps the raw (trimmed) hint.
    const record = store
      .listActiveThreads(conversationId)
      .find((thread) => thread.threadId === first.threadId);
    expect(record?.name).toBe("🔥🚀✨");
  });

  it("falls back to task-N when the hint would slug into the grp- namespace", () => {
    const { store } = createTestContext();
    const conversationId = "conv-grp-hint";
    const result = spawnThread(store, conversationId, "GRP rollout plan");
    expect(result.threadId).toBe("task-1");
  });
});

describe("group create-or-attach", () => {
  it("attaches sibling spawns with the same label to one group", () => {
    const { store } = createTestContext();
    const conversationId = "conv-group-attach";
    const first = spawnThread(
      store,
      conversationId,
      "Compare airlines",
      "Flight research",
    );
    expect(first.groupKey).toBe("grp-flight-research");
    expect(first.groupLabel).toBe("Flight research");

    // Label matching is case-insensitive against ACTIVE groups.
    const second = spawnThread(
      store,
      conversationId,
      "Compare trains",
      "flight RESEARCH",
    );
    expect(second.groupKey).toBe(first.groupKey);
    expect(second.groupLabel).toBe("Flight research");

    expect([...store.listGroupMemberThreadIds(first.groupKey!)].sort()).toEqual(
      [first.threadId, second.threadId].sort(),
    );
  });

  it("attaches by an existing grp- id", () => {
    const { store } = createTestContext();
    const conversationId = "conv-group-id";
    const first = spawnThread(
      store,
      conversationId,
      "Compare airlines",
      "Flight research",
    );
    const second = spawnThread(
      store,
      conversationId,
      "Compare buses",
      first.groupKey!,
    );
    expect(second.groupKey).toBe(first.groupKey);
    expect(second.groupLabel).toBe("Flight research");
  });

  it("mints distinct groups for different labels", () => {
    const { store } = createTestContext();
    const conversationId = "conv-group-distinct";
    const flights = spawnThread(
      store,
      conversationId,
      "Compare airlines",
      "Flight research",
    );
    const hotels = spawnThread(
      store,
      conversationId,
      "Compare hotels",
      "Hotel research",
    );
    expect(flights.groupKey).toBe("grp-flight-research");
    expect(hotels.groupKey).toBe("grp-hotel-research");
    expect(hotels.groupKey).not.toBe(flights.groupKey);
  });

  it("suffixes group keys when different labels slug identically", () => {
    const { store } = createTestContext();
    const conversationId = "conv-group-suffix";
    const a = spawnThread(store, conversationId, "Task one", "Flight research");
    // Different label (so no case-insensitive label match) but same slug.
    const b = spawnThread(
      store,
      conversationId,
      "Task two",
      "Flight research!!!",
    );
    expect(a.groupKey).toBe("grp-flight-research");
    expect(b.groupKey).toBe("grp-flight-research-2");
  });

  it("suffixes group keys that collide with an existing thread key", () => {
    const { store } = createTestContext();
    const conversationId = "conv-cross-namespace";
    // An explicitly requested threadId may occupy the grp- namespace.
    store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
      threadId: "grp-payments",
    });
    const grouped = spawnThread(
      store,
      conversationId,
      "Reconcile invoices",
      "Payments",
    );
    expect(grouped.groupKey).toBe("grp-payments-2");
  });
});

describe("slot-based eviction", () => {
  it("evicts only the LRU singleton when a 17th slot is created", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-evict-singleton";
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS; i += 1) {
      ids.push(
        spawnThread(store, conversationId, `Singleton task ${i}`).threadId,
      );
    }
    expect(store.listActiveThreads(conversationId)).toHaveLength(
      MAX_ACTIVE_RUNTIME_THREADS,
    );

    const overflow = spawnThread(store, conversationId, "Overflow task");
    const active = activeThreadIds(store, conversationId);
    expect(active).toHaveLength(MAX_ACTIVE_RUNTIME_THREADS);
    expect(active).not.toContain(ids[0]);
    expect(active).toContain(ids[1]);
    expect(active).toContain(overflow.threadId);
    expect(threadStatus(db, ids[0]!)).toBe("evicted");
    expect(threadStatus(db, ids[1]!)).toBe("active");
  });

  it("counts a multi-member group as one slot and does not evict when attaching members", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-group-slot";
    const first = spawnThread(
      store,
      conversationId,
      "Fetch Q1 numbers",
      "Data pipeline",
    );
    const groupKey = first.groupKey!;
    for (let i = 2; i <= 4; i += 1) {
      spawnThread(
        store,
        conversationId,
        `Fetch Q${i} numbers`,
        "Data pipeline",
      );
    }
    // Group (1 slot) + 15 singletons = 16 slots, 19 active threads.
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS - 1; i += 1) {
      spawnThread(store, conversationId, `Side quest ${i}`);
    }
    expect(store.listActiveThreads(conversationId)).toHaveLength(
      MAX_ACTIVE_RUNTIME_THREADS + 3,
    );

    // Attaching a 5th member occupies the group's existing slot: no eviction.
    const fifth = spawnThread(
      store,
      conversationId,
      "Fetch annual numbers",
      groupKey,
    );
    expect(fifth.groupKey).toBe(groupKey);
    expect(store.listActiveThreads(conversationId)).toHaveLength(
      MAX_ACTIVE_RUNTIME_THREADS + 4,
    );
    const evicted = db
      .prepare(
        "SELECT COUNT(*) AS count FROM runtime_threads WHERE conversation_id = ? AND status = 'evicted'",
      )
      .get(conversationId) as { count: number };
    expect(evicted.count).toBe(0);
  });

  it("evicts every member of the LRU slot together when that slot is a group", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-evict-group";
    const members = [
      spawnThread(store, conversationId, "Scrape airline A", "Flight scrape"),
      spawnThread(store, conversationId, "Scrape airline B", "Flight scrape"),
      spawnThread(store, conversationId, "Scrape airline C", "Flight scrape"),
      spawnThread(store, conversationId, "Scrape airline D", "Flight scrape"),
    ];
    // 15 newer singletons → 16 slots, the group is the LRU slot.
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS - 1; i += 1) {
      spawnThread(store, conversationId, `Filler ${i}`);
    }

    const fresh = spawnThread(store, conversationId, "Latest task");
    const active = activeThreadIds(store, conversationId);
    expect(active).toHaveLength(MAX_ACTIVE_RUNTIME_THREADS);
    expect(active).toContain(fresh.threadId);
    for (const member of members) {
      expect(active).not.toContain(member.threadId);
      expect(threadStatus(db, member.threadId)).toBe("evicted");
    }
  });
});

describe("group member cap", () => {
  it("throws on the 9th active member, pointing at send_input", () => {
    const { store } = createTestContext();
    const conversationId = "conv-member-cap";
    const first = spawnThread(store, conversationId, "Worker 1", "Bulk import");
    for (let i = 2; i <= MAX_GROUP_MEMBER_THREADS; i += 1) {
      spawnThread(store, conversationId, `Worker ${i}`, "Bulk import");
    }
    expect(store.listGroupMemberThreadIds(first.groupKey!)).toHaveLength(
      MAX_GROUP_MEMBER_THREADS,
    );
    expect(() =>
      spawnThread(
        store,
        conversationId,
        `Worker ${MAX_GROUP_MEMBER_THREADS + 1}`,
        "Bulk import",
      ),
    ).toThrow(/send_input/);
  });
});

describe("whole-group resurrection", () => {
  it("reactivates every group sibling when resolving an evicted member's threadId", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-resurrect";
    const members = [
      spawnThread(store, conversationId, "Plan flights", "Trip planning"),
      spawnThread(store, conversationId, "Plan hotels", "Trip planning"),
      spawnThread(store, conversationId, "Plan activities", "Trip planning"),
    ];
    // 16 newer singletons: the 16th pushes the conversation past budget
    // and evicts the group slot.
    const fillers: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS; i += 1) {
      fillers.push(spawnThread(store, conversationId, `Filler ${i}`).threadId);
    }
    for (const member of members) {
      expect(threadStatus(db, member.threadId)).toBe("evicted");
    }

    vi.advanceTimersByTime(1_000);
    const resolved = store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
      threadId: members[1]!.threadId,
    });
    expect(resolved.reused).toBe(true);
    expect(resolved.threadId).toBe(members[1]!.threadId);
    expect(resolved.groupKey).toBe(members[0]!.groupKey);
    expect(resolved.groupLabel).toBe("Trip planning");

    const active = activeThreadIds(store, conversationId);
    for (const member of members) {
      expect(active).toContain(member.threadId);
    }
    // At budget, resurrection evicts the LRU slot first (oldest filler).
    expect(active).not.toContain(fillers[0]);
    expect(threadStatus(db, fillers[0]!)).toBe("evicted");
  });

  it("resurrects the whole group when attaching new work by grp- id", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-resurrect-attach";
    const m1 = spawnThread(
      store,
      conversationId,
      "Index docs",
      "Knowledge base",
    );
    const m2 = spawnThread(
      store,
      conversationId,
      "Embed docs",
      "Knowledge base",
    );
    const groupKey = m1.groupKey!;
    const fillers: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS; i += 1) {
      fillers.push(spawnThread(store, conversationId, `Filler ${i}`).threadId);
    }
    expect(threadStatus(db, m1.threadId)).toBe("evicted");
    expect(threadStatus(db, m2.threadId)).toBe("evicted");

    const added = spawnThread(store, conversationId, "Refresh index", groupKey);
    expect(added.groupKey).toBe(groupKey);
    expect(threadStatus(db, m1.threadId)).toBe("active");
    expect(threadStatus(db, m2.threadId)).toBe("active");
    expect(threadStatus(db, added.threadId)).toBe("active");
    // Reactivating at budget evicted the LRU filler.
    expect(threadStatus(db, fillers[0]!)).toBe("evicted");
  });
});

describe("searchThreads", () => {
  it("finds evicted threads by a name token and reports their status", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-search-evicted";
    const target = spawnThread(
      store,
      conversationId,
      "Compare flight prices Tokyo",
    );
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS; i += 1) {
      spawnThread(store, conversationId, `Filler ${i}`);
    }
    expect(threadStatus(db, target.threadId)).toBe("evicted");

    const results = store.searchThreads({ conversationId, query: "flight" });
    expect(results.map((thread) => thread.threadId)).toEqual([target.threadId]);
    expect(results[0]?.status).toBe("evicted");
    expect(results[0]?.name).toBe("Compare flight prices Tokyo");
  });

  it("ranks threads matching more tokens first without dropping partial matches", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-rank";
    const both = spawnThread(
      store,
      conversationId,
      "Compare flight prices Tokyo",
    );
    const hotel = spawnThread(
      store,
      conversationId,
      "Compare hotel prices Tokyo",
    );
    const paris = spawnThread(
      store,
      conversationId,
      "Compare flight prices Paris",
    );
    spawnThread(store, conversationId, "Organize tax documents");

    // Two-token match outranks single-token matches; among equal scores
    // the most recently used thread wins; zero-token matches drop out.
    const results = store.searchThreads({
      conversationId,
      query: "flight tokyo",
    });
    expect(results.map((thread) => thread.threadId)).toEqual([
      both.threadId,
      paris.threadId,
      hotel.threadId,
    ]);
  });

  it("ignores stopwords so verbose natural-language queries still match", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-stopwords";
    const match = spawnThread(
      store,
      conversationId,
      "Compare flight prices Tokyo",
    );
    spawnThread(store, conversationId, "Organize tax documents");

    // Under strict AND this query returned nothing: "the"/"from"/"last"
    // never appear in the thread, and unmatched tokens excluded it.
    const results = store.searchThreads({
      conversationId,
      query: "the flight comparison from last week",
    });
    expect(results.map((thread) => thread.threadId)).toEqual([match.threadId]);
  });

  it("still searches when every token is a stopword", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-all-stopwords";
    const match = spawnThread(store, conversationId, "What is it tracker");
    spawnThread(store, conversationId, "Organize tax documents");

    const results = store.searchThreads({
      conversationId,
      query: "what is it",
    });
    expect(results.map((thread) => thread.threadId)).toEqual([match.threadId]);
  });

  it("returns the most recent threads first when no query is given", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-recent";
    const a = spawnThread(store, conversationId, "Oldest job");
    const b = spawnThread(store, conversationId, "Middle job");
    const c = spawnThread(store, conversationId, "Newest job");

    const results = store.searchThreads({ conversationId });
    expect(results.map((thread) => thread.threadId)).toEqual([
      c.threadId,
      b.threadId,
      a.threadId,
    ]);
  });

  it("excludes orchestrator-typed threads and the conversation's own thread key", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-excluded";
    store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "orchestrator",
      nameHint: "Coordinate flight booking",
    });
    // A general-typed thread keyed by the conversation id itself is also
    // excluded (it is the conversation, not work).
    store.resolveOrCreateActiveThread({
      conversationId,
      agentType: "general",
      threadId: conversationId,
    });
    const real = spawnThread(store, conversationId, "Book flight seats");

    expect(
      store.searchThreads({ conversationId }).map((thread) => thread.threadId),
    ).toEqual([real.threadId]);
    expect(
      store
        .searchThreads({ conversationId, query: "flight" })
        .map((thread) => thread.threadId),
    ).toEqual([real.threadId]);
  });

  it("respects the limit, keeping the most recent matches", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-limit";
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(spawnThread(store, conversationId, `Batch job ${i}`).threadId);
    }
    const results = store.searchThreads({ conversationId, limit: 3 });
    expect(results.map((thread) => thread.threadId)).toEqual([
      ids[4],
      ids[3],
      ids[2],
    ]);
  });

  it("treats LIKE wildcards in the query as literals", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-wildcards";
    const percent = spawnThread(
      store,
      conversationId,
      "Reach 100% test coverage",
    );
    spawnThread(store, conversationId, "Process 1000 records");
    const underscore = spawnThread(
      store,
      conversationId,
      "Audit snake_case columns",
    );
    spawnThread(store, conversationId, "Audit snakeycase columns");

    expect(
      store
        .searchThreads({ conversationId, query: "100%" })
        .map((thread) => thread.threadId),
    ).toEqual([percent.threadId]);
    expect(
      store
        .searchThreads({ conversationId, query: "snake_case" })
        .map((thread) => thread.threadId),
    ).toEqual([underscore.threadId]);
  });

  it("matches the runtime_agents description via the LEFT JOIN", () => {
    const { store } = createTestContext();
    const conversationId = "conv-search-description";
    const thread = spawnThread(store, conversationId, "Quiet thread");
    store.saveAgentRecord({
      threadId: thread.threadId,
      conversationId,
      agentType: "general",
      description: "Investigating quarterly revenue anomalies",
      agentDepth: 1,
      status: "completed",
      startedAt: Date.now(),
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const results = store.searchThreads({
      conversationId,
      query: "anomalies",
    });
    expect(results.map((t) => t.threadId)).toEqual([thread.threadId]);
    expect(results[0]?.description).toBe(
      "Investigating quarterly revenue anomalies",
    );
  });
});

describe("getThreadGroup / listGroupMemberThreadIds", () => {
  it("returns the group key and label for grouped threads", () => {
    const { store } = createTestContext();
    const conversationId = "conv-group-lookup";
    const grouped = spawnThread(
      store,
      conversationId,
      "Member one",
      "Research pod",
    );
    expect(store.getThreadGroup(grouped.threadId)).toEqual({
      groupKey: "grp-research-pod",
      groupLabel: "Research pod",
    });
  });

  it("returns an empty object for ungrouped threads and undefined for unknown keys", () => {
    const { store } = createTestContext();
    const conversationId = "conv-group-lookup-misc";
    const solo = spawnThread(store, conversationId, "Solo task");
    expect(store.getThreadGroup(solo.threadId)).toEqual({});
    expect(store.getThreadGroup("no-such-thread")).toBeUndefined();
  });

  it("lists every member thread id of a group, including evicted ones", () => {
    const { db, store } = createTestContext();
    const conversationId = "conv-group-members";
    const a = spawnThread(store, conversationId, "Member one", "Research pod");
    const b = spawnThread(store, conversationId, "Member two", "Research pod");
    expect([...store.listGroupMemberThreadIds(a.groupKey!)].sort()).toEqual(
      [a.threadId, b.threadId].sort(),
    );
    // Evict the group; membership listing is status-independent.
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS; i += 1) {
      spawnThread(store, conversationId, `Filler ${i}`);
    }
    expect(threadStatus(db, a.threadId)).toBe("evicted");
    expect([...store.listGroupMemberThreadIds(a.groupKey!)].sort()).toEqual(
      [a.threadId, b.threadId].sort(),
    );
    expect(store.listGroupMemberThreadIds("grp-missing")).toEqual([]);
  });
});

describe("buildActiveThreadsPrompt", () => {
  const makeThread = (
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

  it("renders grouped threads under a labeled header with indented members", () => {
    const now = 1_700_000_000_000;
    const prompt = buildActiveThreadsPrompt(
      [
        makeThread({
          threadId: "scrape-airline-a",
          groupKey: "grp-flight-research",
          groupLabel: "Flight research",
          lastUsedAt: now - 60_000,
          description: "Scrape airline A fares",
          // Currently executing a turn.
          agentStatus: "running",
        }),
        makeThread({
          threadId: "scrape-airline-b",
          groupKey: "grp-flight-research",
          groupLabel: "Flight research",
          lastUsedAt: now - 120_000,
          agentStatus: "completed",
        }),
        makeThread({
          threadId: "solo-task",
          lastUsedAt: now - 30_000,
          agentStatus: "completed",
        }),
      ],
      now,
    );

    // The group has a running member, so its header aggregate reads active.
    expect(prompt).toContain(
      "## Flight research [grp-flight-research] (active, last active 1m ago)",
    );
    // Members are indented under the group header, each with its own state.
    expect(prompt).toContain(
      "\n  - scrape-airline-a (active, last active 1m ago)",
    );
    expect(prompt).toContain(
      "\n  - scrape-airline-b (paused, last active 2m ago)",
    );
    expect(prompt).toContain("    description: Scrape airline A fares");
    // The ungrouped singleton renders flat, exactly like the historical format.
    expect(prompt).toContain("\n- solo-task (paused, last active just now)");
    expect(prompt).toContain("Recall");
  });

  it("labels a currently executing thread active and an idle one paused", () => {
    const now = 1_700_000_000_000;
    const prompt = buildActiveThreadsPrompt(
      [
        makeThread({
          threadId: "running-now",
          lastUsedAt: now - 10 * 60_000,
          // A fresh agent turn keeps recency honest even if the thread row
          // wasn't re-touched.
          agentUpdatedAt: now - 60_000,
          agentStatus: "running",
        }),
        makeThread({
          threadId: "idle-thread",
          lastUsedAt: now - 5 * 60_000,
          agentStatus: "completed",
        }),
        makeThread({
          threadId: "errored-thread",
          lastUsedAt: now - 2 * 60_000,
          agentStatus: "error",
        }),
      ],
      now,
    );

    expect(prompt).toContain("\n- running-now (active, last active 1m ago)");
    expect(prompt).toContain("\n- idle-thread (paused, last active 5m ago)");
    expect(prompt).toContain(
      "\n- errored-thread (paused (last run errored), last active 2m ago)",
    );
  });

  it("renders a one-member group flat without a header", () => {
    const now = 1_700_000_000_000;
    const prompt = buildActiveThreadsPrompt(
      [
        makeThread({
          threadId: "lonely-member",
          groupKey: "grp-solo-pod",
          groupLabel: "Solo pod",
          lastUsedAt: now,
        }),
      ],
      now,
    );
    expect(prompt).not.toContain("##");
    expect(prompt).toContain(
      "\n- lonely-member (paused, last active just now)",
    );
  });

  it("returns an empty string when there are no threads", () => {
    expect(buildActiveThreadsPrompt([], 1_700_000_000_000)).toBe("");
  });

  it("derives active vs paused end-to-end from the runtime_agents.status join", () => {
    // Full-stack proof: real SessionStore + real SQLite. The roster's
    // active/paused signal must come from runtime_agents.status via the
    // LEFT JOIN, not from anything the caller mocks.
    const { store } = createTestContext();
    const conversationId = "conv-live-state";
    const running = spawnThread(store, conversationId, "Deploy the backend");
    const idle = spawnThread(store, conversationId, "Draft the budget memo");

    const persistAgent = (
      threadId: string,
      status: "running" | "completed",
    ): void => {
      const at = Date.now();
      store.saveAgentRecord({
        threadId,
        conversationId,
        agentType: "general",
        description:
          threadId === running.threadId
            ? "Deploy the backend"
            : "Draft the budget memo",
        agentDepth: 1,
        status,
        startedAt: at,
        completedAt: status === "completed" ? at : null,
        updatedAt: at,
      });
    };
    persistAgent(running.threadId, "running");
    persistAgent(idle.threadId, "completed");

    const now = Date.now();
    const prompt = buildActiveThreadsPrompt(
      store.listActiveThreads(conversationId),
      now,
    );

    expect(prompt).toContain(`- ${running.threadId} (active, last active`);
    expect(prompt).toContain(`- ${idle.threadId} (paused, last active`);
  });
});

describe("review-fix regressions", () => {
  it("searchThreads excludes implicit ::subagent:: transcript rows", () => {
    const { store } = createTestContext();
    spawnThread(store, "conv-x", "Real flight research");
    // Simulate an ephemeral workflow agent's implicit transcript row.
    store.updateThreadSummary(
      "conv-x::subagent::general::wf-research-a1",
      "internal transcript",
    );
    const results = store.searchThreads({ conversationId: "conv-x" });
    expect(results.map((thread) => thread.threadId)).toEqual([
      "real-flight-research",
    ]);
  });

  it("attaching to a fully-evicted group at the member cap throws instead of bypassing it", () => {
    const { store } = createTestContext();
    let groupId: string | undefined;
    for (let i = 0; i < MAX_GROUP_MEMBER_THREADS; i++) {
      const created = spawnThread(
        store,
        "conv-cap",
        `Member ${i}`,
        groupId ?? "Big batch",
      );
      groupId = created.groupKey;
    }
    // Evict the whole group by filling the remaining slots.
    for (let i = 0; i < MAX_ACTIVE_RUNTIME_THREADS; i++) {
      spawnThread(store, "conv-cap", `Filler ${i}`);
    }
    expect(() => spawnThread(store, "conv-cap", "One more", groupId)).toThrow(
      /send_input/,
    );
  });

  it("a stale grp- id mints a clean key instead of grp-grp-…", () => {
    const { store } = createTestContext();
    const created = spawnThread(
      store,
      "conv-stale",
      "Follow-up work",
      "grp-tokyo-trip-from-another-conversation",
    );
    expect(created.groupKey).toBe("grp-tokyo-trip-from-another-conversation");
    expect(created.groupKey?.startsWith("grp-grp-")).toBe(false);
    expect(created.groupLabel).toBe("tokyo-trip-from-another-conversation");
  });

  it("thread slugs never land in the legacy- feature-id namespace", () => {
    const { store } = createTestContext();
    const created = spawnThread(store, "conv-legacy", "Legacy data import");
    expect(created.threadId).toBe("task-1");
  });
});
