import { afterEach, describe, expect, it } from "vitest";
import { DreamInboxStore } from "../../../../../runtime/kernel/memory/dream-inbox-store.js";
import { createSqliteTestContextFactory } from "../../../helpers/sqlite-test-context.js";

const testContexts = createSqliteTestContextFactory(
  "stella-dream-inbox",
  (db) => new DreamInboxStore(db),
);
const createTestContext = testContexts.create;

afterEach(() => testContexts.cleanup());

describe("DreamInboxStore", () => {
  it("queues thread summaries and marks them processed by id", () => {
    const { store } = createTestContext();

    store.recordThreadSummary({
      threadId: "thread-a",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "First summary",
    });
    store.recordThreadSummary({
      threadId: "thread-b",
      runId: "run-2",
      agentType: "general",
      rolloutSummary: "Second summary",
    });
    store.recordThreadSummary({
      threadId: "thread-c",
      runId: "run-3",
      agentType: "general",
      rolloutSummary: "Third summary",
    });

    const unprocessed = store.listUnprocessed();
    expect(unprocessed).toHaveLength(3);
    expect(store.countUnprocessed()).toBe(3);

    const [first, second] = unprocessed;
    const result = store.markProcessed({ ids: [first!.id, second!.id] });
    expect(result.updated).toBe(2);

    const remaining = store.listUnprocessed();
    expect(remaining.map((row) => row.runId)).toEqual(["run-3"]);
    expect(store.countUnprocessed()).toBe(1);
  });

  it("re-recording a thread summary resets its processed state", () => {
    const { store } = createTestContext();

    store.recordThreadSummary({
      threadId: "thread-a",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "Initial output",
    });
    const [row] = store.listUnprocessed();
    store.markProcessed({ ids: [row!.id] });
    expect(store.countUnprocessed()).toBe(0);

    store.recordThreadSummary({
      threadId: "thread-a",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "Updated output",
    });
    const after = store.listUnprocessed();
    expect(after).toHaveLength(1);
    expect(after[0]?.content).toBe("Updated output");
  });

  it("requeues surfaced evidence and prioritizes it by usage", () => {
    const { store } = createTestContext();
    store.recordThreadSummary({
      threadId: "thread-used",
      runId: "run-used",
      agentType: "general",
      rolloutSummary: "Frequently recalled work",
    });
    store.recordThreadSummary({
      threadId: "thread-other",
      runId: "run-other",
      agentType: "general",
      rolloutSummary: "Other work",
    });
    const rows = store.listUnprocessed();
    store.markProcessed({ ids: rows.map((row) => row.id) });

    store.recordUsage("thread-used", "run-used");

    expect(store.countUnprocessed()).toBe(1);
    expect(store.listUnprocessed()[0]).toMatchObject({
      threadId: "thread-used",
      runId: "run-used",
      usageCount: 1,
    });
  });

  it("resolves surfaced thread ids directly even when they are older than 200 rows", () => {
    const { store } = createTestContext();
    store.recordThreadSummary({
      threadId: "thread-old-target",
      runId: "run-old-target",
      agentType: "general",
      rolloutSummary: "Old but relevant work",
    });
    for (let index = 0; index < 205; index += 1) {
      store.recordThreadSummary({
        threadId: `thread-new-${index}`,
        runId: `run-new-${index}`,
        agentType: "general",
        rolloutSummary: `Newer work ${index}`,
      });
    }

    expect(store.listRecentThreadSummaries({ limit: 200 })).not.toContainEqual(
      expect.objectContaining({ threadId: "thread-old-target" }),
    );
    expect(store.findThreadSummariesByThreadIds(["thread-old-target"])).toEqual(
      [
        expect.objectContaining({
          threadId: "thread-old-target",
          runId: "run-old-target",
        }),
      ],
    );
  });

  it("debounces usage-driven Dream requeues while retaining usage counts", () => {
    const { store } = createTestContext();
    store.recordThreadSummary({
      threadId: "thread-used",
      runId: "run-used",
      agentType: "general",
      rolloutSummary: "Frequently recalled work",
    });
    const [initial] = store.listUnprocessed();
    store.markProcessed({ ids: [initial!.id], processedAt: 9_000 });

    store.recordUsage("thread-used", "run-used", {
      nowMs: 10_000,
      requeueDebounceMs: 1_000,
    });
    expect(store.countUnprocessed()).toBe(1);
    store.markProcessed({ ids: [initial!.id], processedAt: 10_100 });

    store.recordUsage("thread-used", "run-used", {
      nowMs: 10_500,
      requeueDebounceMs: 1_000,
    });
    expect(store.countUnprocessed()).toBe(0);
    expect(
      store.findThreadSummariesByThreadIds(["thread-used"])[0],
    ).toMatchObject({ usageCount: 2, lastUsage: 10_500 });

    store.recordUsage("thread-used", "run-used", {
      nowMs: 12_000,
      requeueDebounceMs: 1_000,
    });
    expect(store.countUnprocessed()).toBe(1);
    expect(store.listUnprocessed()[0]).toMatchObject({ usageCount: 3 });
  });

  it("redacts secrets before content enters the inbox", () => {
    const { store } = createTestContext();

    store.recordThreadSummary({
      threadId: "thread-secret",
      runId: "run-secret",
      agentType: "general",
      rolloutSummary:
        "Final output included OPENAI_API_KEY=sk-testsecret12345678901234567890",
    });

    const serialized = JSON.stringify(store.listUnprocessed());
    expect(serialized).not.toContain("sk-testsecret12345678901234567890");
    expect(serialized).toContain("OPENAI_API_KEY=");
    expect(serialized).toContain("***");
  });

  it("coalesces chronicle digests per window while unprocessed", () => {
    const { store } = createTestContext();

    store.recordChronicleSummary({
      window: "10m",
      content: "- Editing the runtime kernel",
      uniqueLines: 12,
    });
    store.recordChronicleSummary({
      window: "10m",
      content: "- Now reviewing a pull request",
      uniqueLines: 9,
    });
    store.recordChronicleSummary({
      window: "6h",
      content: "- A whole afternoon of Stella work",
      uniqueLines: 80,
    });

    const unprocessed = store.listUnprocessed();
    expect(unprocessed).toHaveLength(2);
    const tenMinute = unprocessed.find((row) => row.sourceKey === "10m");
    expect(tenMinute?.kind).toBe("chronicle");
    expect(tenMinute?.content).toBe("- Now reviewing a pull request");
    expect(tenMinute?.metadata).toMatchObject({
      window: "10m",
      uniqueLines: 9,
    });
  });

  it("stores memory notes as formatted candidates and lists them newest first", () => {
    const { store } = createTestContext();

    store.recordMemoryNote({
      title: "Concise updates",
      category: "user_preference",
      memory: "User prefers concise implementation updates.",
      recallHooks: ["concise", "updates"],
      evidence: ["User asked for shorter status updates."],
      createdAt: new Date("2026-05-28T12:34:56.000Z"),
    });
    store.recordMemoryNote({
      title: "Dark mode default",
      category: "user_preference",
      memory: "The user wants dark mode as the default theme.",
      recallHooks: ["dark mode", "theme"],
      evidence: ["User said: remember I want dark mode"],
      createdAt: new Date("2026-05-29T08:00:00.000Z"),
    });

    const notes = store.listRecentMemoryNotes();
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("dark mode as the default theme");
    expect(notes[1]).toContain("concise implementation updates");
    expect(notes[0]).toContain("## Recall hooks");

    const rows = store.listUnprocessed();
    const noteRows = rows.filter((row) => row.kind === "memory_note");
    expect(noteRows).toHaveLength(2);
    expect(noteRows.map((row) => row.title)).toContain("Dark mode default");
  });

  it("keeps same-title memory notes distinct instead of overwriting", () => {
    const { store } = createTestContext();
    const createdAt = new Date("2026-05-28T12:00:00.000Z");

    store.recordMemoryNote({
      title: "Same title",
      category: "active_focus",
      memory: "First candidate.",
      recallHooks: [],
      evidence: [],
      createdAt,
    });
    store.recordMemoryNote({
      title: "Same title",
      category: "active_focus",
      memory: "Second candidate.",
      recallHooks: [],
      evidence: [],
      createdAt,
    });

    expect(store.listRecentMemoryNotes()).toHaveLength(2);
  });

  it("redacts secrets when formatting a memory note", () => {
    const { store } = createTestContext();

    store.recordMemoryNote({
      title: "Secret note",
      category: "active_focus",
      memory: "User pasted OPENAI_API_KEY=sk-testsecret12345678901234567890",
      recallHooks: ["sk-testsecret12345678901234567890"],
      evidence: ["Authorization: Bearer sk-testsecret12345678901234567890"],
      createdAt: new Date("2026-05-28T12:00:00.000Z"),
    });

    const [note] = store.listRecentMemoryNotes();
    expect(note).not.toContain("sk-testsecret12345678901234567890");
    expect(note).toContain("OPENAI_API_KEY=");
    expect(note).toContain("***");
  });

  it("lists recent thread summaries regardless of processed state", () => {
    const { store } = createTestContext();

    store.recordThreadSummary({
      threadId: "thread-a",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "Older work",
    });
    store.recordChronicleSummary({ window: "10m", content: "- noise" });
    const [first] = store.listUnprocessed();
    store.markProcessed({ ids: [first!.id] });

    const recents = store.listRecentThreadSummaries();
    expect(recents).toHaveLength(1);
    expect(recents[0]?.kind).toBe("thread_summary");
    expect(recents[0]?.threadId).toBe("thread-a");
  });

  it("tracks the pending frontier and a monotonic pass watermark", () => {
    const { store } = createTestContext();
    expect(store.pendingFrontier()).toBe(0);
    expect(store.readConsolidationWatermark()).toBeNull();

    store.recordThreadSummary({
      threadId: "thread-a",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "Pending work",
    });
    const frontier = store.pendingFrontier();
    expect(frontier).toBeGreaterThan(0);

    store.writeConsolidationWatermark({ frontier, completedAt: 111 });
    expect(store.readConsolidationWatermark()).toEqual({
      frontier,
      completedAt: 111,
    });

    // Monotonic: a delayed writer can never move the frontier backwards.
    store.writeConsolidationWatermark({ frontier: frontier - 500, completedAt: 222 });
    expect(store.readConsolidationWatermark()).toEqual({
      frontier,
      completedAt: 222,
    });

    // Draining the queue zeroes the frontier.
    const ids = store.listUnprocessed().map((row) => row.id);
    store.markProcessed({ ids });
    expect(store.pendingFrontier()).toBe(0);
  });

  describe("gcProcessedRows", () => {
    const DAY_MS = 24 * 60 * 60 * 1_000;

    it("deletes only processed, unused, non-chronicle rows past retention", () => {
      const { store } = createTestContext();
      const now = Date.now();
      const old = now - 40 * DAY_MS;

      store.recordThreadSummary({
        threadId: "thread-old-processed",
        runId: "run-1",
        agentType: "general",
        rolloutSummary: "Long consumed",
      });
      store.recordThreadSummary({
        threadId: "thread-old-unprocessed",
        runId: "run-2",
        agentType: "general",
        rolloutSummary: "Never consumed — queue state is sacred",
      });
      store.recordThreadSummary({
        threadId: "thread-recently-processed",
        runId: "run-3",
        agentType: "general",
        rolloutSummary: "Freshly consumed",
      });
      store.recordThreadSummary({
        threadId: "thread-old-but-used",
        runId: "run-4",
        agentType: "general",
        rolloutSummary: "Old but recently surfaced to the orchestrator",
      });
      store.recordChronicleSummary({ window: "10m", content: "- digest" });

      const byThread = (threadId: string) =>
        store
          .listUnprocessed({ limit: 100 })
          .find((row) => row.threadId === threadId);
      store.markProcessed({
        ids: [byThread("thread-old-processed")!.id],
        processedAt: old,
      });
      store.markProcessed({
        ids: [byThread("thread-recently-processed")!.id],
        processedAt: now - 1 * DAY_MS,
      });
      const usedRowId = byThread("thread-old-but-used")!.id;
      store.markProcessed({ ids: [usedRowId], processedAt: old });
      // First surface requeues (last_usage was NULL); re-consume, then a
      // second surface inside the debounce keeps the row processed while
      // stamping a recent last_usage — the exact "old but recently useful"
      // shape the usage guard must retain.
      store.recordUsage("thread-old-but-used", "run-4", { nowMs: now - 60_000 });
      store.markProcessed({ ids: [usedRowId], processedAt: old });
      store.recordUsage("thread-old-but-used", "run-4", { nowMs: now });
      // Chronicle row: processed long ago, still exempt.
      const chronicleRow = store
        .listUnprocessed({ limit: 100 })
        .find((row) => row.kind === "chronicle");
      store.markProcessed({ ids: [chronicleRow!.id], processedAt: old });

      const { deleted } = store.gcProcessedRows({ nowMs: now });
      expect(deleted).toBe(1);

      const remainingThreads = store
        .listRecentThreadSummaries({ limit: 100 })
        .map((row) => row.threadId)
        .sort();
      expect(remainingThreads).toEqual([
        "thread-old-but-used",
        "thread-old-unprocessed",
        "thread-recently-processed",
      ]);
    });

    it("honors a custom retention window", () => {
      const { store } = createTestContext();
      const now = Date.now();
      store.recordThreadSummary({
        threadId: "thread-a",
        runId: "run-1",
        agentType: "general",
        rolloutSummary: "Consumed yesterday",
      });
      const [row] = store.listUnprocessed();
      store.markProcessed({
        ids: [row!.id],
        processedAt: now - 2 * DAY_MS,
      });

      expect(store.gcProcessedRows({ nowMs: now }).deleted).toBe(0);
      expect(
        store.gcProcessedRows({ nowMs: now, retentionMs: DAY_MS }).deleted,
      ).toBe(1);
    });
  });

  describe("delta-input support (migration step 6)", () => {
    it("tracks a monotonic per-conversation delta watermark", () => {
      const { store } = createTestContext();
      expect(store.readDeltaWatermark("conv-1")).toBe(0);

      store.advanceDeltaWatermark("conv-1", 5_000);
      expect(store.readDeltaWatermark("conv-1")).toBe(5_000);
      expect(store.readDeltaWatermark("conv-2")).toBe(0);

      // Monotonic: a delayed writer never moves coverage backwards.
      store.advanceDeltaWatermark("conv-1", 4_000);
      expect(store.readDeltaWatermark("conv-1")).toBe(5_000);
      store.advanceDeltaWatermark("conv-1", 6_500);
      expect(store.readDeltaWatermark("conv-1")).toBe(6_500);

      // Invalid advances are ignored.
      store.advanceDeltaWatermark("conv-1", 0);
      store.advanceDeltaWatermark("conv-1", Number.NaN);
      expect(store.readDeltaWatermark("conv-1")).toBe(6_500);
    });

    it("persists the scheduler token baseline with last-write-wins semantics", () => {
      const { store } = createTestContext();
      expect(store.readTokenBaseline()).toBeNull();

      store.writeTokenBaseline(120_000);
      expect(store.readTokenBaseline()).toBe(120_000);

      // The baseline legitimately moves DOWN after a compaction shrink.
      store.writeTokenBaseline(30_000);
      expect(store.readTokenBaseline()).toBe(30_000);

      store.writeTokenBaseline(-5);
      expect(store.readTokenBaseline()).toBe(30_000);
    });

    it("hides only the delta-covered slice from the list: same conversation + covered kinds", () => {
      const { store } = createTestContext();
      store.recordThreadSummary({
        threadId: "thread-a",
        runId: "run-1",
        agentType: "general",
        rolloutSummary: "rollout from conv-b",
        conversationId: "conv-b",
      });
      store.recordThreadSummary({
        threadId: "thread-x",
        runId: "run-2",
        agentType: "general",
        rolloutSummary: "rollout from another conversation",
        conversationId: "conv-a",
      });
      store.recordThreadSummary({
        threadId: "thread-legacy",
        runId: "run-3",
        agentType: "general",
        rolloutSummary: "legacy row without a conversation",
      });
      store.recordMemoryNote(
        {
          title: "Note",
          category: "active_focus",
          memory: "candidate from conv-b",
          recallHooks: [],
          evidence: [],
        },
        { conversationId: "conv-b" },
      );
      store.recordChronicleSummary({ window: "10m", content: "screen digest" });

      expect(store.listUnprocessed()).toHaveLength(5);
      const visible = store.listUnprocessed({
        excludeConversationKinds: {
          conversationId: "conv-b",
          kinds: ["thread_summary", "memory_note"],
          sinceTs: 0,
        },
      });
      // conv-b's covered rows are hidden (the delta carries them); the
      // other-conversation row, the legacy NULL row, and chronicle remain.
      expect(visible.map((row) => row.threadId ?? row.kind).sort()).toEqual([
        "chronicle",
        "thread-legacy",
        "thread-x",
      ]);
    });

    it("neither hides nor consumes pre-window rows — spans covered only by shadow passes stay on the model path", () => {
      const { store } = createTestContext();
      const old = new Date(Date.now() - 120_000);
      // Recorded long before the pass's window: its span was covered only
      // by shadow passes, whose proposals are discarded by design — no
      // applied derivation ever read it.
      store.recordMemoryNote(
        {
          title: "Pre-window note",
          category: "active_focus",
          memory: "only ever shadow-covered",
          recallHooks: [],
          evidence: [],
          createdAt: old,
        },
        { conversationId: "conv-a" },
      );
      store.recordThreadSummary({
        threadId: "thread-in-window",
        runId: "run-1",
        agentType: "general",
        rolloutSummary: "inside the pass window",
        conversationId: "conv-a",
      });
      const windowStart = old.getTime() + 30_000;
      const windowEnd = Date.now() + 30_000;

      // First cutover pass over (windowStart, windowEnd]: the old row is
      // outside the derivation window — it must not be swept…
      const { updated } = store.markKindsProcessedThrough({
        conversationId: "conv-a",
        kinds: ["thread_summary", "memory_note"],
        sinceTs: windowStart,
        throughTs: windowEnd,
      });
      expect(updated).toBe(1);
      // …and it must still be VISIBLE to the model-driven list despite
      // matching the conversation and kind.
      const visible = store.listUnprocessed({
        excludeConversationKinds: {
          conversationId: "conv-a",
          kinds: ["thread_summary", "memory_note"],
          sinceTs: windowStart,
        },
      });
      expect(visible).toHaveLength(1);
      expect(visible[0]?.title).toBe("Pre-window note");
    });

    it("never mechanically consumes rows from conversations the delta did not cover (reviewer A/B scenario)", () => {
      const { store } = createTestContext();
      // Conversation A: subagent finishes at T1; row recorded, then A is
      // abandoned — no further Dream trigger ever fires from A.
      store.recordThreadSummary({
        threadId: "thread-a",
        runId: "run-1",
        agentType: "general",
        rolloutSummary: "report only conversation A's window ever held",
        conversationId: "conv-a",
      });
      // Legacy row from before the conversation column existed.
      store.recordThreadSummary({
        threadId: "thread-legacy",
        runId: "run-legacy",
        agentType: "general",
        rolloutSummary: "legacy report",
      });
      const rowA = store
        .listUnprocessed()
        .find((row) => row.threadId === "thread-a")!;
      expect(rowA.conversationId).toBe("conv-a");

      // Conversation B's delta pass completes with coverage PAST T1. Under
      // the pre-fix semantics this consumed A's row (and GC would later
      // delete it) although its content never entered any delta.
      const { updated } = store.markKindsProcessedThrough({
        conversationId: "conv-b",
        kinds: ["thread_summary", "memory_note"],
        sinceTs: rowA.sourceUpdatedAt - 60_000,
        throughTs: rowA.sourceUpdatedAt + 60_000,
      });
      expect(updated).toBe(0);
      expect(store.countUnprocessed()).toBe(2);

      // Only A's own delta pass may consume A's row; the legacy NULL row is
      // untouchable mechanically and stays for the model-driven path.
      const consumed = store.markKindsProcessedThrough({
        conversationId: "conv-a",
        kinds: ["thread_summary", "memory_note"],
        sinceTs: rowA.sourceUpdatedAt - 60_000,
        throughTs: rowA.sourceUpdatedAt + 60_000,
      });
      expect(consumed.updated).toBe(1);
      const remaining = store.listUnprocessed();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.threadId).toBe("thread-legacy");
    });

    it("marks covered rows through a timestamp within one conversation, sparing newer rows and chronicle", () => {
      const { store } = createTestContext();
      const old = new Date(Date.now() - 60_000);
      store.recordMemoryNote(
        {
          title: "Old note",
          category: "active_focus",
          memory: "old",
          recallHooks: [],
          evidence: [],
          createdAt: old,
        },
        { conversationId: "conv-a" },
      );
      store.recordThreadSummary({
        threadId: "thread-a",
        runId: "run-1",
        agentType: "general",
        rolloutSummary: "recent rollout",
        conversationId: "conv-a",
      });
      store.recordChronicleSummary({ window: "10m", content: "digest" });

      const throughTs = old.getTime() + 1;
      const { updated } = store.markKindsProcessedThrough({
        conversationId: "conv-a",
        kinds: ["thread_summary", "memory_note"],
        sinceTs: old.getTime() - 60_000,
        throughTs,
      });
      expect(updated).toBe(1);
      const remaining = store.listUnprocessed();
      expect(remaining.map((row) => row.kind).sort()).toEqual([
        "chronicle",
        "thread_summary",
      ]);
    });

    it("reports the processed frontier for rows consumed since a pass started", () => {
      const { store } = createTestContext();
      store.recordThreadSummary({
        threadId: "thread-a",
        runId: "run-1",
        agentType: "general",
        rolloutSummary: "first",
      });
      store.recordThreadSummary({
        threadId: "thread-b",
        runId: "run-2",
        agentType: "general",
        rolloutSummary: "second",
      });
      const rows = store.listUnprocessed();
      expect(rows).toHaveLength(2);
      const passStartedAt = Date.now();
      expect(store.maxProcessedSourceUpdatedAtSince(passStartedAt)).toBe(0);

      // Consume only one row: the frontier reflects it, not the full queue.
      const consumed = rows[0]!;
      store.markProcessed({ ids: [consumed.id] });
      expect(store.maxProcessedSourceUpdatedAtSince(passStartedAt)).toBe(
        consumed.sourceUpdatedAt,
      );
      // Rows consumed before the pass start are invisible to it.
      expect(
        store.maxProcessedSourceUpdatedAtSince(Date.now() + 60_000),
      ).toBe(0);
    });
  });
});
