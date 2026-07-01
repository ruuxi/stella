import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildContextLookupUserPrompt,
  formatActiveThreads,
  formatThreadSearch,
  parseRecallAction,
} from "../../../../../runtime/kernel/agent-runtime/context-lookup.js";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../../../../../runtime/kernel/storage/database-init.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

const roots = new Set<string>();

const createRoot = async (): Promise<{
  rootPath: string;
  db: SqliteDatabase;
}> => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-context-lookup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roots.add(rootPath);
  await mkdir(path.join(rootPath, "memories"), { recursive: true });
  await mkdir(path.join(rootPath, "memories_extensions", "chronicle"), {
    recursive: true,
  });
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  return { rootPath, db };
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("buildContextLookupUserPrompt", () => {
  it("builds a relevance prompt with memory files before Chronicle", async () => {
    const { rootPath, db } = await createRoot();
    await writeFile(
      path.join(rootPath, "memories", "memory_summary.md"),
      "Working on Stella memory routing.",
    );
    await writeFile(
      path.join(rootPath, "memories_extensions", "chronicle", "10m-current.md"),
      "User was looking at a browser tab about context tools.",
    );

    const store: Parameters<typeof buildContextLookupUserPrompt>[0]["store"] = {
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
      stellaDataDir: rootPath,
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
    expect(prompt).toContain("Safari - Context docs");
    expect(prompt).toContain("https://example.com/live-context");
    expect(prompt).toContain("https://example.com/context-tools");
    expect(prompt).toContain("Selected Stella panel");
    expect(prompt).toContain("thread-1");
    expect(prompt).toContain('<chronicle_snapshot window="last ~10 minutes"');
    expect(prompt.indexOf("# Memory Files")).toBeLessThan(
      prompt.indexOf("# Chronicle Context"),
    );
  });

  it("adds matched memory lines when search terms are provided", async () => {
    const { rootPath, db } = await createRoot();
    await writeFile(
      path.join(rootPath, "memories", "memory_summary.md"),
      "Working on Stella memory routing.",
    );
    await writeFile(
      path.join(rootPath, "memories", "MEMORY.md"),
      [
        "# MEMORY",
        "",
        "## 2026-05-28 — Mini window spaces",
        "Outcome: Mini window follows spaces only when pinned.",
        "Recall hooks: mini window, pinned, macOS spaces",
        "",
        "## 2026-05-27 — Unrelated release",
        "Outcome: Built launcher release assets.",
      ].join("\n"),
    );

    const store: Parameters<typeof buildContextLookupUserPrompt>[0]["store"] = {
      listActiveThreads: () => [],
      listAgentProgressSummaries: () => [],
    };

    const prompt = await buildContextLookupUserPrompt({
      conversationId: "conv-1",
      lookupPrompt: "What did we decide about the mini window?",
      memorySearchTerms: ["mini window", "pinned"],
      stellaDataDir: rootPath,
      store,
      localEvents: [],
    });

    db.close();

    expect(prompt).toContain("# Memory Search Results");
    expect(prompt).toContain('<memory_search terms="mini window, pinned">');
    expect(prompt).toContain(
      '<match path="~/.stella/memories/MEMORY.md" lines="2-6">',
    );
    expect(prompt).toContain(
      "4: Outcome: Mini window follows spaces only when pinned.",
    );
    expect(prompt).not.toContain("Built launcher release assets.");
    expect(prompt).toContain("Full ~/.stella/memories/MEMORY.md omitted");
  });
});

describe("parseRecallAction", () => {
  it("parses each action shape, tolerating fences and prose", () => {
    expect(
      parseRecallAction('{"action":"search_memory","terms":["budget","app"]}'),
    ).toEqual({ action: "search_memory", terms: ["budget", "app"] });

    expect(
      parseRecallAction(
        'Sure:\n```json\n{"action":"search_threads","query":"flight research"}\n```',
      ),
    ).toEqual({ action: "search_threads", query: "flight research" });

    expect(
      parseRecallAction(
        '{"action":"answer","brief":"Nothing relevant found."}',
      ),
    ).toEqual({ action: "answer", brief: "Nothing relevant found." });
  });

  it("drops non-string terms and returns null for prose or unknown actions", () => {
    expect(
      parseRecallAction('{"action":"search_memory","terms":["ok",3,null]}'),
    ).toEqual({ action: "search_memory", terms: ["ok"] });
    expect(parseRecallAction("I could not find anything.")).toBeNull();
    expect(parseRecallAction('{"action":"delete_everything"}')).toBeNull();
  });
});

describe("formatThreadSearch", () => {
  const makeStore = (
    threads: unknown[],
    summariesByAgentId: Record<string, { text: string; atMs: number }[]> = {},
  ) =>
    ({
      searchThreads: () => threads,
      listAgentProgressSummaries: (agentId: string, limit = 3) =>
        (summariesByAgentId[agentId] ?? []).slice(-limit),
    }) as unknown as Parameters<typeof formatThreadSearch>[0];

  it("renders thread_ids with live state, description and clamped summary", () => {
    const now = Date.now();
    const out = formatThreadSearch(
      makeStore([
        {
          threadId: "scrape-airline-a",
          description: "Scrape airline A fares",
          summary: "  found  cheap   fares  ",
          lastUsedAt: now - 3 * 60_000,
          agentStatus: "running",
        },
        {
          threadId: "old-idle-thread",
          description: "Draft the budget",
          lastUsedAt: now - 20 * 60_000,
          agentStatus: "completed",
        },
      ]),
      "conv-1",
      "flights",
      undefined,
    );
    // Recall surfaces the same active/paused signal as the roster.
    expect(out).toContain("- scrape-airline-a (active, last active 3m ago)");
    expect(out).toContain("- old-idle-thread (paused, last active 20m ago)");
    expect(out).toContain("description: Scrape airline A fares");
    expect(out).toContain("summary: found cheap fares");
  });

  it("explains an empty result differently with and without a query", () => {
    expect(
      formatThreadSearch(makeStore([]), "conv-1", "flights", undefined),
    ).toMatch(/No past threads matched/);
    expect(
      formatThreadSearch(makeStore([]), "conv-1", undefined, undefined),
    ).toMatch(/No past threads recorded/);
  });
});

describe("formatActiveThreads", () => {
  const makeStore = (
    threads: unknown[],
    summariesByAgentId: Record<string, { text: string; atMs: number }[]> = {},
  ) =>
    ({
      listActiveThreads: () => threads,
      listAgentProgressSummaries: (agentId: string, limit = 3) =>
        (summariesByAgentId[agentId] ?? []).slice(-limit),
    }) as unknown as Parameters<typeof formatActiveThreads>[0];

  it("surfaces live active/paused state and last-active recency", () => {
    const now = Date.now();
    const out = formatActiveThreads(
      makeStore([
        {
          threadId: "still-running",
          description: "Deploy the backend",
          lastUsedAt: now - 12 * 60_000,
          agentUpdatedAt: now - 60_000,
          agentStatus: "running",
        },
        {
          threadId: "idle-thread",
          description: "Draft the budget",
          lastUsedAt: now - 30 * 60_000,
          agentStatus: "completed",
        },
      ]),
      "conv-1",
    );
    expect(out).toContain("- still-running (active, last active 1m ago)");
    expect(out).toContain("- idle-thread (paused, last active 30m ago)");
    expect(out).toContain("description: Deploy the backend");
  });

  it("reports no resumable threads when empty", () => {
    expect(formatActiveThreads(makeStore([]), "conv-1")).toBe(
      "No resumable agent threads.",
    );
  });

  it("attaches timestamped live progress to ACTIVE threads only", () => {
    const now = Date.now();
    const out = formatActiveThreads(
      makeStore(
        [
          {
            threadId: "still-running",
            description: "Deploy the backend",
            lastUsedAt: now - 60_000,
            agentUpdatedAt: now - 30_000,
            agentStatus: "running",
          },
          {
            threadId: "idle-thread",
            description: "Draft the budget",
            lastUsedAt: now - 30 * 60_000,
            agentStatus: "completed",
          },
        ],
        {
          "still-running": [
            { text: "building the deploy image", atMs: now - 90_000 },
            { text: "running smoke tests", atMs: now - 30_000 },
          ],
          // Present in the buffer but the thread is paused — must not render
          // as live status.
          "idle-thread": [{ text: "summing spreadsheet rows", atMs: now }],
        },
      ),
      "conv-1",
    );
    expect(out).toContain("live progress (newest last):");
    expect(out).toContain("building the deploy image");
    expect(out).toContain("running smoke tests");
    // Each phrase carries its timestamp bracket.
    expect(out).toMatch(/- \[[^\]]+\] running smoke tests/);
    expect(out).not.toContain("summing spreadsheet rows");
  });
});

describe("formatThreadSearch live progress", () => {
  const makeStore = (
    threads: unknown[],
    summariesByAgentId: Record<string, { text: string; atMs: number }[]> = {},
  ) =>
    ({
      searchThreads: () => threads,
      listAgentProgressSummaries: (agentId: string, limit = 3) =>
        (summariesByAgentId[agentId] ?? []).slice(-limit),
    }) as unknown as Parameters<typeof formatThreadSearch>[0];

  it("attaches live progress to matching ACTIVE threads", () => {
    const now = Date.now();
    const out = formatThreadSearch(
      makeStore(
        [
          {
            threadId: "scrape-airline-a",
            description: "Scrape airline A fares",
            lastUsedAt: now - 60_000,
            agentStatus: "running",
          },
        ],
        {
          "scrape-airline-a": [
            { text: "paging through fare results", atMs: now - 20_000 },
          ],
        },
      ),
      "conv-1",
      "flights",
      undefined,
    );
    expect(out).toContain("live progress (newest last):");
    expect(out).toMatch(/- \[[^\]]+\] paging through fare results/);
  });
});
