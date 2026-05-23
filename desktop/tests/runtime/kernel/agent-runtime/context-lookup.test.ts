import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { buildContextLookupUserPrompt } from "../../../../../runtime/kernel/agent-runtime/context-lookup.js";
import { MemoryStore } from "../../../../../runtime/kernel/memory/memory-store.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

const roots = new Set<string>();

const createRoot = async (): Promise<{
  rootPath: string;
  db: SqliteDatabase;
  memoryStore: MemoryStore;
}> => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-context-lookup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roots.add(rootPath);
  await mkdir(path.join(rootPath, "memories"), { recursive: true });
  await mkdir(
    path.join(rootPath, "memories_extensions", "chronicle"),
    { recursive: true },
  );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  return { rootPath, db, memoryStore: new MemoryStore(db) };
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("buildContextLookupUserPrompt", () => {
  it("builds a relevance prompt with stable memory first and Chronicle last", async () => {
    const { rootPath, db, memoryStore } = await createRoot();
    memoryStore.add("user", "User prefers concise answers.");
    await writeFile(
      path.join(rootPath, "memories", "memory_summary.md"),
      "Working on Stella memory routing.",
    );
    await writeFile(
      path.join(
        rootPath,
        "memories_extensions",
        "chronicle",
        "10m-current.md",
      ),
      "User was looking at a browser tab about context tools.",
    );

    const store: Parameters<typeof buildContextLookupUserPrompt>[0]["store"] = {
      memoryStore,
      listActiveThreads: () => [
        {
          conversationId: "conv-1",
          threadId: "thread-1",
          name: "Context work",
          agentType: "general",
          status: "active",
          createdAt: 1,
          lastUsedAt: 2,
          description: "Implement context tool",
          summary: "Added a read-only context lookup",
        },
      ],
    };

    const prompt = await buildContextLookupUserPrompt({
      conversationId: "conv-1",
      lookupPrompt:
        "Find context for what the user means by 'this' in the current app.",
      stellaHome: rootPath,
      store,
      appBrowserContext: {
        apps: [
          {
            name: "Safari",
            pid: 123,
            isActive: true,
            bundleId: "com.apple.Safari",
            windowTitle: "Context tools",
          },
          {
            name: "Cursor",
            pid: 456,
            isActive: false,
            windowTitle: "stella",
          },
        ],
        activeBrowserTab: {
          browser: "Safari",
          bundleId: "com.apple.Safari",
          title: "Context docs",
          url: "https://example.com/live-context",
        },
      },
      localEvents: [
        {
          _id: "u1",
          timestamp: 1,
          type: "user_message",
          payload: {
            text: "How does this work?",
            metadata: {
              context: {
                windowLabel: "Safari - Context docs",
                browserUrl: "https://example.com/context-tools",
                appSelectionLabel: "Selected Stella panel",
              },
            },
          },
        },
        {
          _id: "a1",
          timestamp: 2,
          type: "assistant_message",
          payload: { text: "I can check the relevant context." },
        },
      ],
    });

    db.close();

    expect(prompt).toContain("# Lookup Request");
    expect(prompt).toContain(
      "Find context for what the user means by 'this' in the current app.",
    );
    expect(prompt).not.toContain("# Recent Conversation");
    expect(prompt).not.toContain("How does this work?");
    expect(prompt).not.toContain("I can check the relevant context.");
    expect(prompt).toContain(
      '<memory_file path="~/.stella/memories/memory_summary.md">',
    );
    expect(prompt).toContain('<memory_snapshot target="user">');
    expect(prompt).toContain("Safari - Context docs");
    expect(prompt).toContain("https://example.com/live-context");
    expect(prompt).toContain("https://example.com/context-tools");
    expect(prompt).toContain("Selected Stella panel");
    expect(prompt).toContain("thread-1");
    expect(prompt).toContain('<chronicle_snapshot window="last ~10 minutes"');
    expect(prompt.indexOf("# Durable Memory")).toBeLessThan(
      prompt.indexOf("# Chronicle Context"),
    );
  });
});
