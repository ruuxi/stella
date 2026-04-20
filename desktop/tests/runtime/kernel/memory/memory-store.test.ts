import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import {
  MemoryStore,
  type MemoryToolResult,
} from "../../../../../runtime/kernel/memory/memory-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: MemoryStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (
  opts?: { memoryCharLimit?: number; userCharLimit?: number },
): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-memory-store-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, { timeout: 5000 }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const store = new MemoryStore(db, opts);
  const context = { rootPath, db, store };
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

const expectSuccess = (result: MemoryToolResult): MemoryToolResult => {
  if (!result.success) {
    throw new Error(`Expected success, got: ${JSON.stringify(result)}`);
  }
  return result;
};

const expectFailure = (result: MemoryToolResult): MemoryToolResult => {
  if (result.success) {
    throw new Error(`Expected failure, got: ${JSON.stringify(result)}`);
  }
  return result;
};

describe("MemoryStore.add", () => {
  it("adds a new entry and returns it in the entries array", () => {
    const { store } = createTestContext();
    const result = expectSuccess(store.add("memory", "User runs macOS Sonoma"));
    expect(result.entries).toEqual(["User runs macOS Sonoma"]);
    expect(result.message).toBe("Entry added.");
    expect(result.usage).toMatch(/\d+%.*chars/);
  });

  it("trims whitespace from content before storing", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "  trimmed  "));
    const second = expectSuccess(store.add("memory", "trimmed"));
    expect(second.message).toBe("Entry already exists (no duplicate added).");
    expect(second.entries).toEqual(["trimmed"]);
  });

  it("rejects empty content", () => {
    const { store } = createTestContext();
    const result = expectFailure(store.add("memory", "   "));
    expect(result.error).toContain("empty");
  });

  it("returns success with no-op message for exact duplicates", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("user", "User prefers concise replies"));
    const second = expectSuccess(store.add("user", "User prefers concise replies"));
    expect(second.message).toBe("Entry already exists (no duplicate added).");
    expect(second.entries).toEqual(["User prefers concise replies"]);
  });

  it("rejects entries that would exceed the budget and includes current entries in the error", () => {
    const { store } = createTestContext({ memoryCharLimit: 50, userCharLimit: 50 });
    expectSuccess(store.add("memory", "abcdefghij"));
    expectSuccess(store.add("memory", "klmnopqrst"));
    const oversized = "x".repeat(60);
    const result = expectFailure(store.add("memory", oversized));
    expect(result.error).toMatch(/would exceed the limit/);
    expect(result.entries).toEqual(["abcdefghij", "klmnopqrst"]);
    expect(result.usage).toMatch(/\/50/);
  });

  it("partitions entries between memory and user targets", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "Memory entry"));
    expectSuccess(store.add("user", "User entry"));
    store.loadSnapshot();
    const memoryBlock = store.formatForSystemPrompt("memory");
    const userBlock = store.formatForSystemPrompt("user");
    expect(memoryBlock).toContain("Memory entry");
    expect(memoryBlock).not.toContain("User entry");
    expect(userBlock).toContain("User entry");
    expect(userBlock).not.toContain("Memory entry");
  });
});

describe("MemoryStore.replace", () => {
  it("replaces an entry by unique substring", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "User uses Go 1.22"));
    const result = expectSuccess(
      store.replace("memory", "Go 1.22", "User uses Go 1.23 with sqlc"),
    );
    expect(result.entries).toEqual(["User uses Go 1.23 with sqlc"]);
  });

  it("returns previews when the substring matches multiple distinct entries", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "Project A uses TypeScript"));
    expectSuccess(store.add("memory", "Project B uses TypeScript"));
    const result = expectFailure(store.replace("memory", "TypeScript", "now Rust"));
    expect(result.error).toContain("Multiple entries matched");
    expect(result.matches).toEqual([
      "Project A uses TypeScript",
      "Project B uses TypeScript",
    ]);
  });

  it("returns an error when no entry matches", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "Existing"));
    const result = expectFailure(store.replace("memory", "missing", "new"));
    expect(result.error).toMatch(/No entry matched/);
  });

  it("rejects replacements that would push the budget over", () => {
    const { store } = createTestContext({ memoryCharLimit: 30, userCharLimit: 30 });
    expectSuccess(store.add("memory", "tag"));
    const result = expectFailure(
      store.replace("memory", "tag", "y".repeat(40)),
    );
    expect(result.error).toMatch(/Replacement would put memory at/);
  });
});

describe("MemoryStore.remove", () => {
  it("removes an entry by unique substring", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "first"));
    expectSuccess(store.add("memory", "second"));
    const result = expectSuccess(store.remove("memory", "first"));
    expect(result.entries).toEqual(["second"]);
  });

  it("returns previews when the substring matches multiple distinct entries", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "alpha entry"));
    expectSuccess(store.add("memory", "beta entry"));
    const result = expectFailure(store.remove("memory", "entry"));
    expect(result.error).toContain("Multiple entries matched");
    expect(result.matches).toEqual(["alpha entry", "beta entry"]);
  });

  it("returns an error when no entry matches", () => {
    const { store } = createTestContext();
    const result = expectFailure(store.remove("user", "ghost"));
    expect(result.error).toMatch(/No entry matched/);
  });
});

describe("MemoryStore.formatForSystemPrompt (frozen snapshot)", () => {
  it("returns null before loadSnapshot is called", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "Saved before snapshot"));
    expect(store.formatForSystemPrompt("memory")).toBeNull();
  });

  it("returns the captured block after loadSnapshot, including header and percentage", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "Hermes-style snapshot"));
    store.loadSnapshot();
    const block = store.formatForSystemPrompt("memory");
    expect(block).not.toBeNull();
    expect(block).toContain("MEMORY (your personal notes)");
    expect(block).toContain("Hermes-style snapshot");
    expect(block).toMatch(/\d+%/);
  });

  it("uses the USER PROFILE label for target=user", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("user", "User identity fact"));
    store.loadSnapshot();
    const block = store.formatForSystemPrompt("user");
    expect(block).toContain("USER PROFILE (who the user is)");
  });

  it("does NOT change after a mid-session add (frozen snapshot)", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "captured at snapshot time"));
    store.loadSnapshot();
    const before = store.formatForSystemPrompt("memory");
    expectSuccess(store.add("memory", "added after snapshot"));
    const after = store.formatForSystemPrompt("memory");
    expect(after).toBe(before);
    expect(after).not.toContain("added after snapshot");
  });

  it("does NOT change after a mid-session replace or remove (frozen snapshot)", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "original entry text"));
    expectSuccess(store.add("memory", "second entry"));
    store.loadSnapshot();
    const before = store.formatForSystemPrompt("memory");
    expectSuccess(store.replace("memory", "original", "replaced text"));
    expectSuccess(store.remove("memory", "second"));
    const after = store.formatForSystemPrompt("memory");
    expect(after).toBe(before);
    expect(after).toContain("original entry text");
    expect(after).toContain("second entry");
  });

  it("returns null for a target with no entries", () => {
    const { store } = createTestContext();
    expectSuccess(store.add("memory", "memory only"));
    store.loadSnapshot();
    expect(store.formatForSystemPrompt("memory")).not.toBeNull();
    expect(store.formatForSystemPrompt("user")).toBeNull();
  });

  it("persists across MemoryStore instances (snapshot is captured from disk)", () => {
    const { db, store } = createTestContext();
    expectSuccess(store.add("user", "First identity fact"));
    expectSuccess(store.add("user", "Second identity fact"));

    const fresh = new MemoryStore(db);
    fresh.loadSnapshot();
    const block = fresh.formatForSystemPrompt("user");
    expect(block).toContain("First identity fact");
    expect(block).toContain("Second identity fact");
  });
});
