import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EAGER_RECALL_SEED_MAX_CHARS,
  MAX_THREAD_SEARCH_RESULTS,
  RECALL_BUDGET_EXHAUSTED_TEXT,
  RECALL_EMPTY_BRIEF_TEXT,
  RECALL_NO_OUTPUT_TEXT,
  RECALL_SYSTEM_PROMPT,
  RECALL_TOOL_RUNTIME_SYSTEM_PROMPT,
  buildContextLookupUserPrompt,
  formatThreadSearchResults,
  formatTranscriptSearchResults,
  resolveRecallSearchAction,
  renderCappedRecallSeed,
  runRecall,
} from "../../../../../runtime/kernel/agent-runtime/context-lookup.js";
import type {
  AssistantMessage,
  Context,
  Message,
  ToolResultMessage,
} from "../../../../../runtime/ai/types.js";
import { completeSimple } from "../../../../../runtime/ai/stream.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../../../../../runtime/kernel/integrations/claude-code-agent-runtime.js";

// runRecall drives its steps through completeSimple; the tests script its
// responses. readAssistantText stays real (it reads the fake message text).
vi.mock("../../../../../runtime/ai/stream.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../../runtime/ai/stream.js")
  >()),
  completeSimple: vi.fn(),
}));

// The external-engine path: engine detection defaults to false (matching a
// data dir with no preferences file); the Claude Code tests flip it on and
// script the CLI turn.
vi.mock(
  "../../../../../runtime/kernel/integrations/claude-code-agent-runtime.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../../runtime/kernel/integrations/claude-code-agent-runtime.js")
    >()),
    shouldUseClaudeCodeAgentRuntime: vi.fn(() => false),
    runClaudeCodeAgentTextCompletion: vi.fn(),
  }),
);
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

type LookupStore = Parameters<typeof buildContextLookupUserPrompt>[0]["store"];

const makeLookupStore = (overrides: Partial<LookupStore> = {}): LookupStore =>
  ({
    listThreadsForRecallIndex: () => [],
    listAgentAssistantMessages: () => [],
    searchThreads: () => [],
    searchTranscripts: () => [],
    listTranscriptNeighbors: () => [],
    listThreadResultExcerpts: () => new Map(),
    ...overrides,
  }) as unknown as LookupStore;

describe("buildContextLookupUserPrompt", () => {
  it("pre-seeds thread/transcript/memory searches and orders sections stable → volatile → request", async () => {
    const { rootPath, db } = await createRoot();
    await writeFile(
      path.join(rootPath, "memories", "memory_summary.md"),
      "Working on Stella memory routing.",
    );
    await writeFile(
      path.join(rootPath, "memories_extensions", "chronicle", "10m-current.md"),
      "User was looking at a browser tab about context tools.",
    );

    const now = Date.now();
    const searchThreads = vi.fn(() => [
      {
        threadId: "thread-1",
        conversationId: "conv-1",
        name: "Context work",
        createdAt: now - 60_000,
        lastUsedAt: now - 30_000,
        description: "Implement context tool",
        agentStatus: "completed",
      },
    ]);
    const searchTranscripts = vi.fn(() => [
      {
        conversationId: "conv-2",
        role: "user" as const,
        atMs: now - 90_000,
        text: "let's build the context tool today",
      },
    ]);
    const store = makeLookupStore({
      searchThreads,
      searchTranscripts,
      listThreadResultExcerpts: () =>
        new Map([
          ["thread-1", { resultExcerpt: "Added a read-only context lookup" }],
        ]),
    } as Partial<LookupStore>);

    const prompt = await buildContextLookupUserPrompt({
      conversationId: "conv-1",
      lookupPrompt:
        "Find context for what the user means by 'this' in the current app.",
      searchTerms: ["context tool", "lookup"],
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
      ],
    });

    db.close();

    // The pre-seeded searches ran with the joined terms.
    expect(searchThreads).toHaveBeenCalledWith({
      conversationId: "conv-1",
      query: "context tool lookup",
      limit: MAX_THREAD_SEARCH_RESULTS,
    });
    expect(searchTranscripts).toHaveBeenCalledWith({
      query: "context tool lookup",
      limit: 12,
    });

    expect(prompt).toContain("# Lookup Request");
    expect(prompt).toContain(
      "Find context for what the user means by 'this' in the current app.",
    );
    expect(prompt).toContain(
      '<memory_file path="~/.stella/memories/memory_summary.md">',
    );
    expect(prompt).toContain("thread-1");
    expect(prompt).toContain("result: Added a read-only context lookup");
    expect(prompt).toContain("let's build the context tool today");
    expect(prompt).toContain("Safari - Context docs");
    expect(prompt).toContain("https://example.com/live-context");
    expect(prompt).toContain("Selected Stella panel");
    expect(prompt).toContain('<chronicle_snapshot window="last ~10 minutes"');
    // Pre-seeded evidence leads, live/current state follows, the lookup
    // request comes LAST.
    expect(prompt.indexOf("# Memory Files")).toBeLessThan(
      prompt.indexOf("# Memory Search Results"),
    );
    expect(prompt.indexOf("# Memory Search Results")).toBeLessThan(
      prompt.indexOf("# Agent Thread Search Results"),
    );
    expect(prompt.indexOf("# Agent Thread Search Results")).toBeLessThan(
      prompt.indexOf("# Transcript Search Results"),
    );
    expect(prompt.indexOf("# Transcript Search Results")).toBeLessThan(
      prompt.indexOf("# Current Time"),
    );
    expect(prompt.indexOf("# Live Thread Status")).toBeLessThan(
      prompt.indexOf("# Chronicle Context"),
    );
    expect(prompt.indexOf("# Chronicle Context")).toBeLessThan(
      prompt.indexOf("# Lookup Request"),
    );
    expect(prompt.length).toBeLessThanOrEqual(EAGER_RECALL_SEED_MAX_CHARS);
  });

  it("caps oversized sections deterministically while preserving the lookup tail", () => {
    const sections = [
      {
        heading: "# Memory Search Results",
        body: "m".repeat(20_000),
        maxBodyChars: 10_000,
      },
      {
        heading: "# Lookup Request",
        body: "find the exact prior decision",
        maxBodyChars: 1_000,
      },
    ];
    const first = renderCappedRecallSeed(sections, [1, 0]);
    const second = renderCappedRecallSeed(sections, [1, 0]);

    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(EAGER_RECALL_SEED_MAX_CHARS);
    expect(first).toContain("# Memory Search Results");
    expect(first).toContain("# Lookup Request\nfind the exact prior decision");
  });

  it("includes matched memory lines and omits the full ledger when terms are provided", async () => {
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

    const prompt = await buildContextLookupUserPrompt({
      conversationId: "conv-1",
      lookupPrompt: "What did we decide about the mini window?",
      searchTerms: ["mini window", "pinned"],
      stellaDataDir: rootPath,
      store: makeLookupStore(),
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

  it("puts only RUNNING threads in the live-status tail, with agent messages", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const now = Date.now();
    const store = makeLookupStore({
      listThreadsForRecallIndex: () => [
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
      listAgentAssistantMessages: (agentId: string) =>
        agentId === "still-running"
          ? [{ text: "running smoke tests", atMs: now - 30_000 }]
          : [{ text: "summing spreadsheet rows", atMs: now }],
    } as Partial<LookupStore>);

    const prompt = await buildContextLookupUserPrompt({
      conversationId: "conv-1",
      lookupPrompt: "Is the deploy still running?",
      searchTerms: ["deploy"],
      stellaDataDir: rootPath,
      store,
      localEvents: [],
    });

    const liveSection = prompt.slice(prompt.indexOf("# Live Thread Status"));
    expect(liveSection).toContain("- still-running (active, last active");
    expect(liveSection).toContain("agent updates (newest last):");
    expect(liveSection).toMatch(/- \[[^\]]+\] running smoke tests/);
    // Paused threads never render as live status.
    expect(
      liveSection.slice(0, liveSection.indexOf("# Chronicle Context")),
    ).not.toContain("summing spreadsheet rows");
  });
});

describe("resolveRecallSearchAction", () => {
  it("maps each tool (and legacy aliases) onto a search action", () => {
    expect(
      resolveRecallSearchAction("search_memory", { terms: ["budget", "app"] }),
    ).toEqual({ kind: "search_memory", terms: ["budget", "app"] });
    expect(
      resolveRecallSearchAction("search_transcripts", { query: "emira" }),
    ).toEqual({ kind: "search_transcripts", query: "emira" });
    expect(
      resolveRecallSearchAction("search_threads", {
        query: "flights",
        limit: 5,
      }),
    ).toEqual({ kind: "search_threads", query: "flights", limit: 5 });
    // Legacy names from older transcripts resolve to the nearest tool.
    expect(resolveRecallSearchAction("search", { query: "x" })).toEqual({
      kind: "search_transcripts",
      query: "x",
    });
    expect(
      resolveRecallSearchAction("search_messages", { query: "x" }),
    ).toEqual({ kind: "search_transcripts", query: "x" });
    expect(resolveRecallSearchAction("search_agents", { query: "x" })).toEqual({
      kind: "search_threads",
      query: "x",
    });
  });

  it("drops non-string terms and returns null for unknown tools", () => {
    expect(
      resolveRecallSearchAction("search_memory", { terms: ["ok", 3, null] }),
    ).toEqual({ kind: "search_memory", terms: ["ok"] });
    expect(resolveRecallSearchAction("delete_everything", {})).toBeNull();
  });
});

describe("formatThreadSearchResults", () => {
  const now = Date.UTC(2026, 6, 10, 20, 0);

  const makeStore = (
    threads: unknown[],
    excerpts: Map<
      string,
      { resultExcerpt?: string; errorExcerpt?: string }
    > = new Map(),
    summariesByAgentId: Record<string, { text: string; atMs: number }[]> = {},
    onSearch?: (args: unknown) => void,
  ) =>
    ({
      searchThreads: (args: unknown) => {
        onSearch?.(args);
        return threads;
      },
      listThreadResultExcerpts: () => excerpts,
      listAgentAssistantMessages: (agentId: string, limit = 3) =>
        (summariesByAgentId[agentId] ?? []).slice(-limit),
    }) as unknown as Parameters<typeof formatThreadSearchResults>[0];

  it("renders newest-first with absolute date/time, live state, scope, and result/error excerpts", () => {
    const out = formatThreadSearchResults(
      makeStore(
        [
          // Given oldest-first to prove the formatter re-orders by recency.
          {
            threadId: "older-thread",
            conversationId: "conv-2",
            name: "Draft the budget",
            createdAt: now - 90 * 60_000,
            lastUsedAt: now - 60 * 60_000,
            description: "Draft the household budget spreadsheet",
            agentStatus: "error",
          },
          {
            threadId: "newer-thread",
            conversationId: "conv-1",
            name: "Deploy the backend",
            createdAt: now - 3 * 60_000,
            lastUsedAt: now - 60_000,
            description: "Deploy the backend",
            agentStatus: "completed",
          },
        ],
        new Map([
          ["newer-thread", { resultExcerpt: "Deployed   rev  42\nto prod" }],
          ["older-thread", { errorExcerpt: "spreadsheet API returned 401" }],
        ]),
      ),
      "conv-1",
      "budget deploy",
    );
    expect(out).toContain("[newest → oldest by last activity]");
    expect(out.indexOf("newer-thread")).toBeLessThan(
      out.indexOf("older-thread"),
    );
    // Absolute date/time per entry for recency awareness.
    expect(out).toMatch(/- newer-thread \| last active [A-Z][a-z]{2} \d/);
    expect(out).toContain("| from this conversation | Deploy the backend");
    expect(out).toContain("| from another conversation | Draft the budget");
    // Result/error excerpts collapse whitespace into one dense line.
    expect(out).toContain("result: Deployed rev 42 to prod");
    expect(out).toContain("error: spreadsheet API returned 401");
    // A description identical to the name adds nothing — deduped.
    expect(out).toContain(
      "description: Draft the household budget spreadsheet",
    );
    expect(out).not.toContain("description: Deploy the backend");
  });

  it("attaches agent-authored updates to ACTIVE threads only", () => {
    const liveNow = Date.now();
    const out = formatThreadSearchResults(
      makeStore(
        [
          {
            threadId: "scrape-airline-a",
            conversationId: "conv-1",
            description: "Scrape airline A fares",
            lastUsedAt: liveNow - 60_000,
            agentStatus: "running",
          },
        ],
        new Map(),
        {
          "scrape-airline-a": [
            { text: "paging through fare results", atMs: liveNow - 20_000 },
          ],
        },
      ),
      "conv-1",
      "flights",
    );
    expect(out).toContain("(active, last active");
    expect(out).toContain("agent updates (newest last):");
    expect(out).toMatch(/- \[[^\]]+\] paging through fare results/);
  });

  it("caps the store request at the max even when a larger limit is asked for", () => {
    const calls: Array<{ limit?: number }> = [];
    formatThreadSearchResults(
      makeStore([], new Map(), {}, (args) =>
        calls.push(args as { limit?: number }),
      ),
      "conv-1",
      "anything",
      99,
    );
    expect(calls[0]?.limit).toBe(MAX_THREAD_SEARCH_RESULTS);
  });

  it("explains an empty result differently with and without a query", () => {
    expect(
      formatThreadSearchResults(makeStore([]), "conv-1", "flights"),
    ).toMatch(/No agent threads matched/);
    expect(
      formatThreadSearchResults(makeStore([]), "conv-1", undefined),
    ).toMatch(/No past agent work recorded/);
  });
});

describe("formatTranscriptSearchResults", () => {
  const makeStore = (messageHits: unknown[], neighbors: unknown[] = []) =>
    ({
      searchTranscripts: () => messageHits,
      listTranscriptNeighbors: () => neighbors,
    }) as unknown as Parameters<typeof formatTranscriptSearchResults>[0];

  it("renders dated snippets with conversation scope, oldest → newest", () => {
    const now = Date.now();
    const out = formatTranscriptSearchResults(
      makeStore([
        // Relevance-ranked input: newest/most-relevant first.
        {
          conversationId: "conv-old",
          role: "assistant" as const,
          atMs: now - 1_000,
          text: "took the Emira out to Saguaro Lake",
        },
        {
          conversationId: "conv-1",
          role: "user" as const,
          atMs: now - 500_000,
          text: "emira day",
        },
      ]),
      "conv-1",
      "emira saguaro",
    );
    expect(out).toContain("[oldest → newest — read as a timeline]");
    // Older message renders FIRST even though the newer one ranked higher.
    expect(out.indexOf("emira day")).toBeLessThan(
      out.indexOf("took the Emira out to Saguaro Lake"),
    );
    expect(out).toMatch(/User \(this conversation\): emira day/);
    expect(out).toMatch(
      /Stella \(conversation …nv-old\): took the Emira out to Saguaro Lake/,
    );
  });

  it("expands top message hits with their surrounding exchange", () => {
    const atMs = Date.UTC(2026, 5, 25, 19);
    const out = formatTranscriptSearchResults(
      makeStore(
        [
          {
            conversationId: "conv-old",
            role: "assistant" as const,
            atMs,
            text: "drop this in maps: Saguaro Lake Marina, 14011 N Bush Hwy",
          },
        ],
        [
          {
            conversationId: "conv-old",
            role: "user" as const,
            atMs: atMs - 60_000,
            text: "Give me address so I can tap on my phone",
          },
          {
            conversationId: "conv-old",
            role: "user" as const,
            atMs: atMs + 60_000,
            text: "damn i love the car. lol.",
          },
        ],
      ),
      "conv-1",
      "saguaro marina",
    );
    expect(out).toContain("surrounding exchange:");
    expect(out).toMatch(/\[[^\]]+\] User: Give me address so I can tap/);
    expect(out).toMatch(/\[[^\]]+\] User: damn i love the car/);
  });

  it("windows long message texts around the first matching token", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(40);
    const out = formatTranscriptSearchResults(
      makeStore([
        {
          conversationId: "conv-old",
          role: "user" as const,
          atMs: Date.now(),
          text: `${filler} the emira felt amazing on that road ${filler}`,
        },
      ]),
      "conv-1",
      "emira",
    );
    expect(out).toContain("emira felt amazing");
    expect(out).toContain("…");
    // Snippet stays bounded instead of dumping the whole message.
    expect(out.length).toBeLessThan(800);
  });

  it("explains empty results and unusable queries", () => {
    expect(
      formatTranscriptSearchResults(makeStore([]), "conv-1", "flights"),
    ).toMatch(/Nothing matched in past conversation transcripts/);
    // The tokenizer keeps all-stopword queries searchable; only an EMPTY
    // query has no usable terms.
    expect(
      formatTranscriptSearchResults(makeStore([]), "conv-1", undefined),
    ).toMatch(/No usable search terms/);
  });
});

describe("runRecall", () => {
  const assistantText = (text: string): AssistantMessage =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: Date.now(),
    }) as unknown as AssistantMessage;

  const assistantToolCalls = (
    calls: Array<{
      id?: string;
      name: string;
      arguments: Record<string, unknown>;
    }>,
  ): AssistantMessage =>
    ({
      role: "assistant",
      content: calls.map((call, index) => ({
        type: "toolCall",
        id: call.id ?? `call-${index}`,
        name: call.name,
        arguments: call.arguments,
      })),
      stopReason: "toolUse",
      timestamp: Date.now(),
    }) as unknown as AssistantMessage;

  const lastContext = (): Context => {
    const calls = vi.mocked(completeSimple).mock.calls;
    return calls[calls.length - 1]?.[1] as Context;
  };

  const makeRunArgs = async (
    rootPath: string,
    storeOverrides: Record<string, unknown> = {},
  ) => ({
    conversationId: "conv-1",
    lookupPrompt: "Is the connector-discovery thread still running?",
    memorySearchTerms: ["connector", "discovery"],
    stellaAppDir: rootPath,
    stellaDataDir: rootPath,
    store: {
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
      listAgentAssistantMessages: () => [],
      searchThreads: () => [],
      searchTranscripts: () => [],
      listTranscriptNeighbors: () => [],
      listThreadResultExcerpts: () => new Map(),
      ...storeOverrides,
    } as unknown as Parameters<typeof runRecall>[0]["store"],
    localEvents: [],
    recallRoute: {
      activeEngine: "default",
      executionEngine: "native",
      modelId: "test-provider/test-model",
      resolvedLlm: {
        model: { id: "test-model" },
        getApiKey: async () => "test-key",
      },
    } as unknown as Parameters<typeof runRecall>[0]["recallRoute"],
  });

  it("advertises the native tools, executes a tool round, and returns the final text brief", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const searchTranscripts = vi.fn(() => [
      {
        conversationId: "conv-2",
        role: "user" as const,
        atMs: Date.parse("2026-07-01T10:00:00Z"),
        text: "the wifi password at the lake house is PINETREE42",
      },
    ]);
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    completions
      .mockResolvedValueOnce(
        assistantToolCalls([
          {
            id: "call-wifi",
            name: "search_transcripts",
            arguments: { query: "lake house wifi password" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        assistantText("The lake house wifi password is PINETREE42."),
      );
    const telemetryRecords: Array<
      Parameters<NonNullable<Parameters<typeof runRecall>[0]["onTelemetry"]>>[0]
    > = [];

    const out = await runRecall({
      ...(await makeRunArgs(rootPath, { searchTranscripts })),
      telemetry: {
        routeMs: 12.5,
        hostContextMs: 3.25,
        sourceTimings: {
          "host.localEvents": {
            kind: "sql",
            calls: 1,
            ms: 0.5,
            chars: 0,
          },
        },
      },
      onTelemetry: (record) => telemetryRecords.push(record),
    });

    expect(out).toBe("The lake house wifi password is PINETREE42.");
    expect(completions).toHaveBeenCalledTimes(2);
    // Pre-seed searched with the orchestrator's terms; the model's own call
    // reformulated.
    expect(searchTranscripts).toHaveBeenCalledWith({
      query: "connector discovery",
      limit: 12,
    });
    expect(searchTranscripts).toHaveBeenCalledWith({
      query: "lake house wifi password",
      limit: 12,
    });

    const context = lastContext();
    expect(context.systemPrompt).toBe(RECALL_SYSTEM_PROMPT);
    expect(context.tools?.map((tool) => tool.name)).toEqual([
      "search_memory",
      "search_transcripts",
      "search_threads",
    ]);
    // History is real turns: seed user message, assistant tool call, then a
    // toolResult carrying the observation.
    const [seedMessage, assistantTurn, toolResult] = context.messages as [
      Message,
      Message,
      ToolResultMessage,
    ];
    expect(seedMessage.role).toBe("user");
    expect(assistantTurn.role).toBe("assistant");
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("call-wifi");
    expect(toolResult.isError).toBe(false);
    expect(toolResult.content[0]).toMatchObject({ type: "text" });
    expect((toolResult.content[0] as { text: string }).text).toContain(
      "PINETREE42",
    );
    expect(telemetryRecords).toHaveLength(1);
    expect(telemetryRecords[0]).toMatchObject({
      version: 1,
      conversationId: "conv-1",
      outcome: "answer",
      engine: "native",
      modelId: "test-provider/test-model",
      routeMs: 12.5,
      hostContextMs: 3.25,
      modelCalls: 2,
      toolRounds: 1,
    });
    expect(telemetryRecords[0]?.seedChars).toBeGreaterThan(0);
    expect(telemetryRecords[0]?.seedSearchMs).toBeGreaterThanOrEqual(0);
    expect(telemetryRecords[0]?.assemblyMs).toBeGreaterThanOrEqual(0);
    expect(telemetryRecords[0]?.modelMs).toBeGreaterThanOrEqual(0);
    expect(telemetryRecords[0]?.totalMs).toBeGreaterThanOrEqual(0);
    expect(telemetryRecords[0]?.sourceTimings).toMatchObject({
      "host.localEvents": { kind: "sql", calls: 1, ms: 0.5 },
      "seed.memoryFiles": { kind: "file", calls: 1 },
      "seed.memorySearch": { kind: "file", calls: 1 },
      "seed.chronicleFiles": { kind: "file", calls: 1 },
      "seed.threadSearch": { kind: "sql", calls: 1 },
      "seed.transcriptSearch": { kind: "sql", calls: 1 },
      "seed.liveThreadStatus": { kind: "sql", calls: 1 },
      "tool.transcriptSearch": { kind: "sql", calls: 1 },
    });
  });

  it("executes parallel tool calls from one turn and answers unknown tools with an error result", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const searchThreads = vi.fn(() => []);
    const searchTranscripts = vi.fn(() => []);
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    completions
      .mockResolvedValueOnce(
        assistantToolCalls([
          {
            id: "a",
            name: "search_threads",
            arguments: { query: "connector" },
          },
          {
            id: "b",
            name: "search_transcripts",
            arguments: { query: "connector" },
          },
          { id: "c", name: "nonsense", arguments: {} },
        ]),
      )
      .mockResolvedValueOnce(assistantText("No trace of it."));

    const out = await runRecall(
      await makeRunArgs(rootPath, { searchThreads, searchTranscripts }),
    );

    expect(out).toBe("No trace of it.");
    // Pre-seed + the model's own round.
    expect(searchThreads).toHaveBeenCalledTimes(2);
    expect(searchTranscripts).toHaveBeenCalledTimes(2);
    const toolResults = lastContext().messages.filter(
      (message): message is ToolResultMessage => message.role === "toolResult",
    );
    expect(toolResults.map((result) => result.toolCallId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(toolResults[2]?.isError).toBe(true);
    expect((toolResults[2]?.content[0] as { text: string }).text).toContain(
      "search_memory, search_transcripts, or search_threads",
    );
  });

  it("rejects a nothing-found answer given without any model search, then accepts the corrected answer", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    completions
      .mockResolvedValueOnce(assistantText("Nothing relevant found."))
      .mockResolvedValueOnce(
        assistantText("connector-discovery-take-2 is active."),
      );

    const out = await runRecall(await makeRunArgs(rootPath));

    expect(out).toBe("connector-discovery-take-2 is active.");
    expect(completions).toHaveBeenCalledTimes(2);
    // The retry turn carries the rejection as a user message after the
    // rejected assistant turn.
    const messages = lastContext().messages;
    const lastUser = messages[messages.length - 1] as Message & {
      content: Array<{ text: string }>;
    };
    expect(lastUser.role).toBe("user");
    expect(lastUser.content[0]?.text).toContain("Rejected: you answered");
  });

  it("accepts nothing-found once the model has searched on its own", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    completions
      .mockResolvedValueOnce(
        assistantToolCalls([
          {
            name: "search_threads",
            arguments: { query: "connector discovery" },
          },
        ]),
      )
      .mockResolvedValueOnce(assistantText("Nothing relevant found."));

    const out = await runRecall(await makeRunArgs(rootPath));
    expect(out).toBe("Nothing relevant found.");
    expect(completions).toHaveBeenCalledTimes(2);
  });

  const assistantFailure = (
    stopReason: "error" | "aborted",
    errorMessage?: string,
  ): AssistantMessage =>
    ({
      role: "assistant",
      content: [],
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
      timestamp: Date.now(),
    }) as unknown as AssistantMessage;

  it("retries a transport-failed completion and returns the recovered brief", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    completions
      .mockResolvedValueOnce(
        assistantFailure(
          "error",
          "Connection recovery failed: unexpected EOF (stream ended before a terminal event)",
        ),
      )
      .mockResolvedValueOnce(
        assistantText("connector-discovery-take-2 is active."),
      );

    const out = await runRecall(await makeRunArgs(rootPath));

    expect(out).toBe("connector-discovery-take-2 is active.");
    expect(completions).toHaveBeenCalledTimes(2);
  });

  it("gives up after bounded transport retries and returns the lookup-failure text", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    completions.mockResolvedValue(
      assistantFailure("error", "relay stream reset by peer"),
    );

    const out = await runRecall(await makeRunArgs(rootPath));

    expect(out).toBe(RECALL_NO_OUTPUT_TEXT);
    // First attempt plus the bounded retries — never an unbounded loop.
    expect(completions).toHaveBeenCalledTimes(3);
  });

  it("does not retry an aborted completion", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    completions.mockResolvedValue(assistantFailure("aborted"));

    const out = await runRecall(await makeRunArgs(rootPath));

    expect(out).toBe(RECALL_NO_OUTPUT_TEXT);
    expect(completions).toHaveBeenCalledTimes(1);
  });

  it("retries a transport failure mid-lookup after a successful tool round", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    completions
      .mockResolvedValueOnce(
        assistantToolCalls([
          {
            name: "search_threads",
            arguments: { query: "connector discovery" },
          },
        ]),
      )
      .mockResolvedValueOnce(assistantFailure("error", "unexpected EOF"))
      .mockResolvedValueOnce(
        assistantText("connector-discovery-take-2 is paused."),
      );

    const out = await runRecall(await makeRunArgs(rootPath));

    expect(out).toBe("connector-discovery-take-2 is paused.");
    expect(completions).toHaveBeenCalledTimes(3);
  });

  it("returns a distinct failure text for an empty brief instead of a fake no-match", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    completions.mockResolvedValueOnce(assistantText(""));

    const out = await runRecall(await makeRunArgs(rootPath));
    expect(out).toBe(RECALL_EMPTY_BRIEF_TEXT);
  });

  it("force-answers after the round budget and returns a distinct failure text when that also fails", async () => {
    const { rootPath, db } = await createRoot();
    db.close();
    const completions = vi.mocked(completeSimple);
    completions.mockReset();
    // Four rounds execute; the fifth tool request trips the budget, its
    // calls get error results, and the forced final synthesis produces
    // nothing.
    for (let i = 0; i < 5; i += 1) {
      completions.mockResolvedValueOnce(
        assistantToolCalls([
          {
            name: "search_transcripts",
            arguments: { query: "connector discovery" },
          },
        ]),
      );
    }
    completions.mockResolvedValueOnce(assistantText(""));

    const telemetryRecords: Array<
      Parameters<NonNullable<Parameters<typeof runRecall>[0]["onTelemetry"]>>[0]
    > = [];
    const out = await runRecall({
      ...(await makeRunArgs(rootPath)),
      onTelemetry: (record) => telemetryRecords.push(record),
    });
    expect(out).toBe(RECALL_BUDGET_EXHAUSTED_TEXT);
    expect(completions).toHaveBeenCalledTimes(6);
    expect(telemetryRecords[0]?.toolRounds).toBe(5);
    const messages = lastContext().messages;
    const budgetResult = messages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" &&
        Boolean(message.isError) &&
        (message.content[0] as { text?: string })?.text?.includes(
          "Search budget exhausted",
        ) === true,
    );
    expect(budgetResult).toBeDefined();
    const lastUser = messages[messages.length - 1] as Message & {
      content: Array<{ text: string }>;
    };
    expect(lastUser.role).toBe("user");
    expect(lastUser.content[0]?.text).toContain("out of search steps");
  });

  describe("on the Claude Code engine", () => {
    type EngineTurn = Parameters<typeof runClaudeCodeAgentTextCompletion>[0];

    const makeClaudeCodeArgs = async (rootPath: string) => {
      const searchTranscripts = vi.fn(() => {
        // The first call is eager seed retrieval. Later calls happen inside
        // Claude's runtime-owned tool loop and must not inflate modelMs.
        if (searchTranscripts.mock.calls.length > 1) {
          const deadline = performance.now() + 20;
          while (performance.now() < deadline) {
            // Deterministic synchronous retrieval stand-in.
          }
        }
        return [
          {
            conversationId: "conv-2",
            role: "user" as const,
            atMs: Date.parse("2026-07-01T10:00:00Z"),
            text: "the wifi password at the lake house is PINETREE42",
          },
        ];
      });
      const repoCheckout = path.join(rootPath, "repo-checkout");
      return {
        args: {
          ...(await makeRunArgs(rootPath, { searchTranscripts })),
          stellaAppDir: repoCheckout,
          recallRoute: {
            activeEngine: "claude_code_local" as const,
            executionEngine: "claude-code" as const,
            modelId: "claude-code/haiku",
            claudeCodeModel: "haiku",
          },
        },
        searchTranscripts,
      };
    };

    it("exposes the three search tools to the engine and routes them to the real backends", async () => {
      const { rootPath, db } = await createRoot();
      db.close();
      vi.mocked(shouldUseClaudeCodeAgentRuntime).mockReturnValue(true);
      const engine = vi.mocked(runClaudeCodeAgentTextCompletion);
      engine.mockReset();
      engine.mockImplementationOnce(async (turn: EngineTurn) => {
        expect(turn.context.systemPrompt).toBe(
          RECALL_TOOL_RUNTIME_SYSTEM_PROMPT,
        );
        expect(turn.effortLevel).toBe("low");
        expect(turn.modelOverride).toBe("haiku");
        expect(turn.stellaAppDir).toBe(rootPath);
        expect(turn.cwd).toBe(path.join(rootPath, "repo-checkout"));
        expect(turn.context.tools?.map((tool) => tool.name)).toEqual([
          "search_memory",
          "search_transcripts",
          "search_threads",
        ]);
        expect(turn.executeTool).toBeDefined();
        turn.onModelRound?.({ messageId: "round-1", toolCallCount: 0 });
        turn.onModelRound?.({ messageId: "round-1", toolCallCount: 3 });
        const hit = await turn.executeTool!("call-1", "search_transcripts", {
          query: "lake house wifi password",
        });
        expect(String(hit.result)).toContain("PINETREE42");
        // Legacy alias still lands on transcript search.
        const aliased = await turn.executeTool!("call-2", "search", {
          query: "lake house",
        });
        expect(aliased.error).toBeUndefined();
        const unknown = await turn.executeTool!("call-3", "nonsense", {});
        expect(unknown.error).toContain(
          "search_memory, search_transcripts, or search_threads",
        );
        turn.onModelRound?.({ messageId: "round-2", toolCallCount: 0 });
        return "The lake house wifi password is PINETREE42.";
      });

      const { args, searchTranscripts } = await makeClaudeCodeArgs(rootPath);
      const telemetryRecords: Array<
        Parameters<
          NonNullable<Parameters<typeof runRecall>[0]["onTelemetry"]>
        >[0]
      > = [];
      const out = await runRecall({
        ...args,
        onTelemetry: (record) => telemetryRecords.push(record),
      });

      expect(out).toBe("The lake house wifi password is PINETREE42.");
      expect(searchTranscripts).toHaveBeenCalledWith({
        query: "lake house wifi password",
        limit: 12,
      });
      expect(telemetryRecords).toHaveLength(1);
      expect(telemetryRecords[0]).toMatchObject({
        modelCalls: 2,
        toolRounds: 1,
      });
      const toolMs =
        telemetryRecords[0]?.sourceTimings["tool.transcriptSearch"]?.ms ?? 0;
      expect(toolMs).toBeGreaterThan(30);
      expect(
        (telemetryRecords[0]?.totalMs ?? 0) -
          (telemetryRecords[0]?.modelMs ?? 0),
      ).toBeGreaterThanOrEqual(toolMs - 5);
      vi.mocked(shouldUseClaudeCodeAgentRuntime).mockReturnValue(false);
    });

    it("rejects a prose nothing-found given without any search, then accepts the searched answer", async () => {
      const { rootPath, db } = await createRoot();
      db.close();
      vi.mocked(shouldUseClaudeCodeAgentRuntime).mockReturnValue(true);
      const engine = vi.mocked(runClaudeCodeAgentTextCompletion);
      engine.mockReset();
      engine
        .mockImplementationOnce(async () => "Nothing relevant found.")
        .mockImplementationOnce(async (turn: EngineTurn) => {
          const prompt = turn.context.messages
            .map((message) =>
              typeof message.content === "string"
                ? message.content
                : message.content
                    .map((part) => ("text" in part ? part.text : ""))
                    .join("\n"),
            )
            .join("\n");
          expect(prompt).toContain("Rejected: you answered");
          await turn.executeTool!("call-1", "search_transcripts", {
            query: "lake house",
          });
          return "Found it: PINETREE42.";
        });

      const { args } = await makeClaudeCodeArgs(rootPath);
      const out = await runRecall(args);

      expect(out).toBe("Found it: PINETREE42.");
      expect(engine).toHaveBeenCalledTimes(2);
      vi.mocked(shouldUseClaudeCodeAgentRuntime).mockReturnValue(false);
    });

    it("counts a failed Claude turn after already observed model rounds", async () => {
      const { rootPath, db } = await createRoot();
      db.close();
      const engine = vi.mocked(runClaudeCodeAgentTextCompletion);
      engine.mockReset();
      engine.mockImplementationOnce(async (turn: EngineTurn) => {
        turn.onModelRound?.({ messageId: "round-1", toolCallCount: 0 });
        throw new Error("transport failed after an observed round");
      });
      const { args } = await makeClaudeCodeArgs(rootPath);
      const telemetryRecords: Array<
        Parameters<
          NonNullable<Parameters<typeof runRecall>[0]["onTelemetry"]>
        >[0]
      > = [];

      await expect(
        runRecall({
          ...args,
          onTelemetry: (record) => telemetryRecords.push(record),
        }),
      ).rejects.toThrow("transport failed after an observed round");
      expect(telemetryRecords).toHaveLength(1);
      expect(telemetryRecords[0]?.modelCalls).toBe(2);
    });
  });
});
