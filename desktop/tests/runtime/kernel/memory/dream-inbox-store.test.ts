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
    expect(tenMinute?.metadata).toMatchObject({ window: "10m", uniqueLines: 9 });
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
});
