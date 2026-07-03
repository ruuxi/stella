import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RECALL_BUDGET_EXHAUSTED_TEXT,
  RECALL_EMPTY_BRIEF_TEXT,
  RECALL_INDEX_BASE_LIMIT,
  RECALL_INDEX_HIGH_VOLUME_LIMIT,
  buildContextLookupUserPrompt,
  formatRecallThreadIndex,
  formatUnifiedSearch,
  parseRecallAction,
  runRecall,
} from "../../../../../runtime/kernel/agent-runtime/context-lookup.js";
import { completeSimple } from "../../../../../runtime/ai/stream.js";

// runRecall drives its steps through completeSimple; the tests script its
// responses. readAssistantText stays real (it reads the fake message text).
vi.mock("../../../../../runtime/ai/stream.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../../runtime/ai/stream.js")
  >()),
  completeSimple: vi.fn(),
}));
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
      countThreadsCreatedSince: () => 1,
      listThreadsForRecallIndex: () => [
        {
          conversationId: "conv-1",
          threadId: "thread-1",
          name: "Context work",
          createdAt: 1,
          lastUsedAt: 2,
          description: "Implement context tool",
          resultExcerpt: "Added a read-only context lookup",
        },
      ],
      listAgentProgressSummaries: () => [],
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
    expect(prompt).toContain("result: Added a read-only context lookup");
    expect(prompt).toContain('<chronicle_snapshot window="last ~10 minutes"');
    // Stable → volatile ordering: the big cacheable thread index leads, the
    // volatile live/current sections follow, the lookup request comes LAST.
    expect(prompt.indexOf("# Thread Index")).toBeLessThan(
      prompt.indexOf("# Memory Files"),
    );
    expect(prompt.indexOf("# Memory Files")).toBeLessThan(
      prompt.indexOf("# Current Time"),
    );
    expect(prompt.indexOf("# Live Thread Status")).toBeLessThan(
      prompt.indexOf("# Chronicle Context"),
    );
    expect(prompt.indexOf("# Chronicle Context")).toBeLessThan(
      prompt.indexOf("# Lookup Request"),
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
      countThreadsCreatedSince: () => 0,
      listThreadsForRecallIndex: () => [],
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
        'Sure:\n```json\n{"action":"search","query":"flight research"}\n```',
      ),
    ).toEqual({ action: "search", query: "flight research" });

    // Pre-unification action names still resolve to the unified search —
    // models echo names they saw in older transcripts.
    expect(
      parseRecallAction('{"action":"search_threads","query":"flights"}'),
    ).toEqual({ action: "search", query: "flights" });
    expect(
      parseRecallAction('{"action":"search_messages","query":"emira drive"}'),
    ).toEqual({ action: "search", query: "emira drive" });

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

describe("formatUnifiedSearch", () => {
  const makeStore = (
    threads: unknown[],
    messageHits: unknown[] = [],
    summariesByAgentId: Record<string, { text: string; atMs: number }[]> = {},
    neighbors: unknown[] = [],
  ) =>
    ({
      searchThreads: () => threads,
      searchTranscripts: () => messageHits,
      listTranscriptNeighbors: () => neighbors,
      listAgentProgressSummaries: (agentId: string, limit = 3) =>
        (summariesByAgentId[agentId] ?? []).slice(-limit),
    }) as unknown as Parameters<typeof formatUnifiedSearch>[0];

  it("renders typed agent-thread entries with live state, description and clamped summary", () => {
    const now = Date.now();
    const out = formatUnifiedSearch(
      makeStore([
        {
          threadId: "scrape-airline-a",
          conversationId: "conv-1",
          description: "Scrape airline A fares",
          summary: "  found  cheap   fares  ",
          lastUsedAt: now - 3 * 60_000,
          agentStatus: "running",
        },
        {
          threadId: "old-idle-thread",
          conversationId: "conv-2",
          description: "Draft the budget",
          lastUsedAt: now - 20 * 60_000,
          agentStatus: "completed",
        },
      ]),
      "conv-1",
      "flights",
      undefined,
    );
    // Recall surfaces the same active/paused signal as the roster, plus a
    // type label and which conversation the work came from.
    expect(out).toContain(
      "- [agent thread] scrape-airline-a (active, last active 3m ago; from this conversation)",
    );
    expect(out).toContain(
      "- [agent thread] old-idle-thread (paused, last active 20m ago; from another conversation)",
    );
    expect(out).toContain("description: Scrape airline A fares");
    expect(out).toContain("summary: found cheap fares");
  });

  it("renders typed message entries as dated snippets with conversation scope", () => {
    const atMs = Date.UTC(2026, 5, 25);
    const out = formatUnifiedSearch(
      makeStore(
        [],
        [
          {
            conversationId: "conv-old",
            role: "assistant",
            atMs,
            text: "closest good one is Bush Highway toward Saguaro Lake",
          },
          {
            conversationId: "conv-1",
            role: "user",
            atMs,
            text: "where should I go for a drive near Saguaro?",
          },
        ],
      ),
      "conv-1",
      "saguaro drive",
      undefined,
    );
    expect(out).toContain("[message]");
    expect(out).toMatch(
      /- \[message\] \[[^\]]*2026[^\]]*\] Stella \(conversation …nv-old\): closest good one is Bush Highway toward Saguaro Lake/,
    );
    expect(out).toMatch(/User \(this conversation\): where should I go/);
  });

  it("selects both types by matched-token score, rendering threads first and messages as an oldest-first timeline", () => {
    const now = Date.now();
    const out = formatUnifiedSearch(
      makeStore(
        [
          {
            threadId: "burrito-guide",
            conversationId: "conv-1",
            description: "Rank burritos near Tempe",
            summary: "Flags spots near Saguaro Lake",
            lastUsedAt: now,
            agentStatus: "completed",
          },
        ],
        [
          {
            conversationId: "conv-old",
            role: "assistant",
            atMs: now - 1_000,
            text: "took the Emira out to Saguaro Lake",
          },
          {
            conversationId: "conv-old",
            role: "user",
            atMs: now - 500_000,
            // Older message renders FIRST in the timeline even though the
            // newer one ranks higher on relevance.
            text: "emira day",
          },
        ],
      ),
      "conv-1",
      "emira saguaro",
      undefined,
    );
    const threadIndex = out.indexOf("[agent thread]");
    const timelineIndex = out.indexOf("[message results below, oldest → newest]");
    expect(threadIndex).toBeGreaterThanOrEqual(0);
    expect(timelineIndex).toBeGreaterThan(threadIndex);
    expect(out.indexOf("emira day")).toBeLessThan(
      out.indexOf("took the Emira out to Saguaro Lake"),
    );
  });

  it("expands top message hits with their surrounding exchange", () => {
    const atMs = Date.UTC(2026, 5, 25, 19);
    const out = formatUnifiedSearch(
      makeStore(
        [],
        [
          {
            conversationId: "conv-old",
            role: "assistant",
            atMs,
            text: "drop this in maps: Saguaro Lake Marina, 14011 N Bush Hwy",
          },
        ],
        {},
        [
          {
            conversationId: "conv-old",
            role: "user",
            atMs: atMs - 60_000,
            text: "Give me address so I can tap on my phone",
          },
          {
            conversationId: "conv-old",
            role: "user",
            atMs: atMs + 60_000,
            text: "damn i love the car. lol.",
          },
        ],
      ),
      "conv-1",
      "saguaro marina",
      undefined,
    );
    expect(out).toContain("surrounding exchange:");
    expect(out).toMatch(/\[[^\]]+\] User: Give me address so I can tap/);
    expect(out).toMatch(/\[[^\]]+\] User: damn i love the car/);
  });

  it("windows long message texts around the first matching token", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(40);
    const out = formatUnifiedSearch(
      makeStore(
        [],
        [
          {
            conversationId: "conv-old",
            role: "user",
            atMs: Date.now(),
            text: `${filler} the emira felt amazing on that road ${filler}`,
          },
        ],
      ),
      "conv-1",
      "emira",
      undefined,
    );
    expect(out).toContain("emira felt amazing");
    expect(out).toContain("…");
    // Snippet stays bounded instead of dumping the whole message.
    expect(out.length).toBeLessThan(600);
  });

  it("explains an empty result differently with and without a query", () => {
    expect(
      formatUnifiedSearch(makeStore([]), "conv-1", "flights", undefined),
    ).toMatch(/Nothing matched/);
    expect(
      formatUnifiedSearch(makeStore([]), "conv-1", undefined, undefined),
    ).toMatch(/No past agent work recorded/);
  });
});

describe("formatRecallThreadIndex", () => {
  const makeStore = (
    threads: unknown[],
    summariesByAgentId: Record<string, { text: string; atMs: number }[]> = {},
    createdLastDay = 0,
    onList?: (args: { limit: number }) => void,
  ) =>
    ({
      countThreadsCreatedSince: () => createdLastDay,
      listThreadsForRecallIndex: (args: { limit: number }) => {
        onList?.(args);
        return threads;
      },
      listAgentProgressSummaries: (agentId: string, limit = 3) =>
        (summariesByAgentId[agentId] ?? []).slice(-limit),
    }) as unknown as Parameters<typeof formatRecallThreadIndex>[0];

  it("renders dense stable entries oldest → newest by last-active with absolute timestamps", () => {
    const now = Date.UTC(2026, 0, 2, 20, 0);
    const out = formatRecallThreadIndex(
      makeStore([
        {
          threadId: "newer-thread",
          conversationId: "conv-1",
          name: "Deploy the backend",
          createdAt: now - 3 * 60_000,
          lastUsedAt: now - 60_000,
          description: "Deploy the backend",
          resultExcerpt: "Deployed   rev  42\nto prod",
        },
        {
          threadId: "older-thread",
          conversationId: "conv-2",
          name: "Draft the budget",
          createdAt: now - 90 * 60_000,
          lastUsedAt: now - 60 * 60_000,
          description: "Draft the household budget spreadsheet",
          errorExcerpt: "spreadsheet API returned 401",
        },
      ]),
      now,
    );
    // Oldest first: churn concentrates at the end for prompt caching.
    expect(out.index.indexOf("older-thread")).toBeLessThan(
      out.index.indexOf("newer-thread"),
    );
    // Absolute timestamps, never relative ages, so entries stay byte-stable.
    expect(out.index).toMatch(/- older-thread \| last active [A-Z][a-z]{2} \d/);
    expect(out.index).not.toMatch(/\dm ago/);
    // Result/error excerpts collapse whitespace into one dense line.
    expect(out.index).toContain("result: Deployed rev 42 to prod");
    expect(out.index).toContain("error: spreadsheet API returned 401");
    // A description identical to the name adds nothing — deduped.
    expect(out.index).toContain(
      "description: Draft the household budget spreadsheet",
    );
    expect(out.index).not.toContain("description: Deploy the backend");
  });

  it("puts only RUNNING threads in the live-status tail, with progress phrases", () => {
    const now = Date.now();
    const out = formatRecallThreadIndex(
      makeStore(
        [
          {
            threadId: "still-running",
            conversationId: "conv-1",
            name: "Deploy the backend",
            createdAt: now - 5 * 60_000,
            lastUsedAt: now - 60_000,
            agentUpdatedAt: now - 30_000,
            agentStatus: "running",
          },
          {
            threadId: "idle-thread",
            conversationId: "conv-1",
            name: "Draft the budget",
            createdAt: now - 60 * 60_000,
            lastUsedAt: now - 30 * 60_000,
            agentStatus: "completed",
          },
        ],
        {
          "still-running": [
            { text: "running smoke tests", atMs: now - 30_000 },
          ],
          // Present in the buffer but the thread is paused — must not render
          // as live status.
          "idle-thread": [{ text: "summing spreadsheet rows", atMs: now }],
        },
      ),
      now,
    );
    expect(out.liveStatus).toContain("- still-running (active, last active");
    expect(out.liveStatus).toContain("live progress (newest last):");
    expect(out.liveStatus).toMatch(/- \[[^\]]+\] running smoke tests/);
    expect(out.liveStatus).not.toContain("idle-thread");
    expect(out.liveStatus).not.toContain("summing spreadsheet rows");
  });

  it("reports an explicit all-paused tail and an empty index", () => {
    const now = Date.now();
    const paused = formatRecallThreadIndex(
      makeStore([
        {
          threadId: "idle-thread",
          conversationId: "conv-1",
          name: "Draft the budget",
          createdAt: now - 60 * 60_000,
          lastUsedAt: now - 30 * 60_000,
          agentStatus: "completed",
        },
      ]),
      now,
    );
    expect(paused.liveStatus).toContain(
      "No agent threads are executing a turn right now",
    );
    const empty = formatRecallThreadIndex(makeStore([]), now);
    expect(empty.index).toBe("No delegated agent threads recorded yet.");
  });

  it("widens the index after a high-volume day", () => {
    const limits: number[] = [];
    const record = (args: { limit: number }) => limits.push(args.limit);
    formatRecallThreadIndex(makeStore([], {}, 40, record), Date.now());
    formatRecallThreadIndex(makeStore([], {}, 150, record), Date.now());
    expect(limits).toEqual([
      RECALL_INDEX_BASE_LIMIT,
      RECALL_INDEX_HIGH_VOLUME_LIMIT,
    ]);
  });
});

describe("formatUnifiedSearch live progress", () => {
  const makeStore = (
    threads: unknown[],
    summariesByAgentId: Record<string, { text: string; atMs: number }[]> = {},
  ) =>
    ({
      searchThreads: () => threads,
      searchTranscripts: () => [],
      listAgentProgressSummaries: (agentId: string, limit = 3) =>
        (summariesByAgentId[agentId] ?? []).slice(-limit),
    }) as unknown as Parameters<typeof formatUnifiedSearch>[0];

  it("attaches live progress to matching ACTIVE threads", () => {
    const now = Date.now();
    const out = formatUnifiedSearch(
      makeStore(
        [
          {
            threadId: "scrape-airline-a",
            conversationId: "conv-1",
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

describe("runRecall", () => {
  const assistantText = (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  });

  const makeRunArgs = async (rootPath: string) => ({
    conversationId: "conv-1",
    lookupPrompt: "Is the connector-discovery thread still running?",
    stellaAppDir: rootPath,
    stellaDataDir: rootPath,
    store: {
      countThreadsCreatedSince: () => 1,
      listThreadsForRecallIndex: () => [
        {
          threadId: "connector-discovery-take-2",
          conversationId: "conv-1",
          name: "Connector discovery + connect cards",
          createdAt: 1,
          lastUsedAt: 2,
          agentStatus: "running",
        },
      ],
      listAgentProgressSummaries: () => [],
      searchThreads: () => [],
      searchTranscripts: () => [],
      listTranscriptNeighbors: () => [],
    } as unknown as Parameters<typeof runRecall>[0]["store"],
    localEvents: [],
    resolvedLlm: {
      model: { id: "test-model" },
      getApiKey: async () => "test-key",
    } as unknown as Parameters<typeof runRecall>[0]["resolvedLlm"],
  });

  it("rejects a nothing-found answer given without any search, then accepts the corrected answer", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    completions
      .mockResolvedValueOnce(
        assistantText('{"action":"answer","brief":"Nothing relevant found."}'),
      )
      .mockResolvedValueOnce(
        assistantText(
          '{"action":"answer","brief":"connector-discovery-take-2 is active."}',
        ),
      );

    const out = await runRecall(await makeRunArgs(rootPath));

    expect(out).toBe("connector-discovery-take-2 is active.");
    expect(completions).toHaveBeenCalledTimes(2);
    // The retry turn carries the rejection observation.
    const retryText = (
      completions.mock.calls[1]?.[1] as {
        messages: Array<{ content: Array<{ text: string }> }>;
      }
    ).messages[0]?.content[0]?.text;
    expect(retryText).toContain("Rejected: you answered");
  });

  it("returns a distinct failure text for an empty brief instead of a fake no-match", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    completions.mockResolvedValueOnce(
      assistantText('{"action":"answer","brief":""}'),
    );

    const out = await runRecall(await makeRunArgs(rootPath));
    expect(out).toBe(RECALL_EMPTY_BRIEF_TEXT);
  });

  it("returns a distinct failure text when the step budget runs out without an answer", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    // Four search steps burn the budget; the forced final synthesis
    // produces nothing.
    for (let i = 0; i < 4; i += 1) {
      completions.mockResolvedValueOnce(
        assistantText('{"action":"search","query":"connector discovery"}'),
      );
    }
    completions.mockResolvedValueOnce(assistantText(""));

    const out = await runRecall(await makeRunArgs(rootPath));
    expect(out).toBe(RECALL_BUDGET_EXHAUSTED_TEXT);
  });
});
