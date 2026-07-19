import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyRecallIntent,
  isRecallNoMatchBrief,
  RecallRetrievalError,
  routeRecallIntent,
  runRecall,
} from "../../../../../runtime/kernel/agent-runtime/context-lookup.js";
import { readMemoryMapDoc } from "../../../../../runtime/kernel/runner/shared.js";
import { redactBenchmarkBrief } from "../../../../../runtime/scripts/recall-benchmark-redaction.js";

const roots = new Set<string>();

const createRoot = async (): Promise<string> => {
  const root = path.join(
    os.tmpdir(),
    `stella-recall-architecture-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roots.add(root);
  await mkdir(path.join(root, "memories"), { recursive: true });
  return root;
};

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

const makeStore = () =>
  ({
    searchThreads: vi.fn(() => []),
    searchTranscripts: vi.fn(() => []),
    listTranscriptNeighbors: vi.fn(() => []),
    listThreadsForRecallIndex: vi.fn(() => []),
    listAgentAssistantMessages: vi.fn(() => []),
    listThreadResultExcerpts: vi.fn(() => new Map()),
    dreamInboxStore: {
      listRecentThreadSummaries: vi.fn(() => []),
      findThreadSummariesByThreadIds: vi.fn(() => []),
      recordUsage: vi.fn(),
    },
  }) as never;

describe("architectural Recall pipeline", () => {
  it("deterministically caps the resident routing map at injection", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_map.md"),
      `# Memory map\n${"x".repeat(7_000)}TAIL_SENTINEL`,
    );

    // The map read stays deterministically capped (write-jail backstop).
    const residentMap = readMemoryMapDoc(root) ?? "";
    expect(residentMap).toContain("resident memory truncated");
    expect(residentMap).not.toContain("TAIL_SENTINEL");
    expect(residentMap.length).toBeLessThan(6_100);
  });

  it("routes common facts to memory and returns matched lines with zero model calls", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_map.md"),
      [
        "# Memory map",
        "- Stella repo path: /Users/rahulnanda/projects/stella",
        "  hooks: stella repo, dev checkout, v1",
      ].join("\n"),
    );
    const getFtsHealth = vi.fn(() => ({
      healthy: true,
      transcriptReady: true,
      threadsReady: true,
    }));
    const records: Array<{ modelCalls: number; fastPath?: boolean }> = [];
    let metadata: { intent: string; fastPath: boolean } | undefined;

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt: "What repo path did we decide for Stella?",
      memorySearchTerms: ["Stella repo", "/Users/rahulnanda/projects/stella"],
      stellaAppDir: root,
      stellaDataDir: root,
      store: makeStore(),
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth,
        listTranscriptNeighborsBatch: vi.fn(() => []),
      },
      onTelemetry: (record) => records.push(record),
      onResultMetadata: (value) => {
        metadata = value;
      },
    });

    expect(brief).toContain("/Users/rahulnanda/projects/stella");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ modelCalls: 0, fastPath: true });
    expect(metadata).toMatchObject({
      intent: "durable_memory",
      fastPath: true,
    });
    expect(getFtsHealth).not.toHaveBeenCalled();
  });

  it("uses delimiter-safe repository anchors and preserves bare stella", async () => {
    const falseRoot = await createRoot();
    await writeFile(
      path.join(falseRoot, "memories", "memory_map.md"),
      "# Memory map\n- stella-v20 repo path: /tmp/stella-v20",
    );
    const makeArgs = (root: string, prompt: string, term: string) => ({
      conversationId: "conv-1",
      lookupPrompt: prompt,
      memorySearchTerms: [term],
      stellaAppDir: root,
      stellaDataDir: root,
      store: makeStore(),
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
    });

    await expect(
      runRecall(makeArgs(falseRoot, "stella-v2", "stella-v2")),
    ).resolves.toBe("Nothing relevant found.");
    await expect(
      runRecall(
        makeArgs(falseRoot, 'Find exact phrase "stella-v2".', "stella-v2"),
      ),
    ).resolves.toBe("Nothing relevant found.");

    for (const adjacentEvidence of [
      "𐐀stella-v2",
      "stella-v2𐐀",
      "Astella-v2",
      "stella-v2Z",
    ]) {
      const adjacentRoot = await createRoot();
      await writeFile(
        path.join(adjacentRoot, "memories", "memory_map.md"),
        `# Memory map\n- ${adjacentEvidence} repo path: /tmp/rejected`,
      );
      await expect(
        runRecall(makeArgs(adjacentRoot, "stella-v2", "stella-v2")),
      ).resolves.toBe("Nothing relevant found.");
    }

    const trueRoot = await createRoot();
    await writeFile(
      path.join(trueRoot, "memories", "memory_map.md"),
      "# Memory map\n- stella repo path: /Users/rahulnanda/projects/stella",
    );
    await expect(
      runRecall(makeArgs(trueRoot, "stella", "stella")),
    ).resolves.toContain("stella repo path");
  });

  it("redacts street addresses and user-home path prefixes", () => {
    expect(
      redactBenchmarkBrief(
        "Rahul drove to the south entrance at 10919 S Central Avenue before dusk.",
      ),
    ).toBe(
      "Rahul drove to the south entrance at [REDACTED POSTAL ADDRESS] before dusk.",
    );
    expect(
      redactBenchmarkBrief(
        "Inspect /Users/reviewer/projects/stella/runtime/kernel/file.ts:20 next.",
      ),
    ).toBe(
      "Inspect [REDACTED HOME]/projects/stella/runtime/kernel/file.ts:20 next.",
    );
  });

  it("fails loudly before thread search when FTS is degraded", async () => {
    const root = await createRoot();
    const store = makeStore() as any;

    await expect(
      runRecall({
        conversationId: "conv-1",
        lookupPrompt: "Find the prior agent thread for browser cleanup",
        memorySearchTerms: ["browser", "cleanup"],
        stellaAppDir: root,
        stellaDataDir: root,
        store,
        localEvents: [],
        recallRoute: {
          activeEngine: "claude_code_local",
          executionEngine: "claude-code",
          modelId: "claude-code/haiku",
          claudeCodeModel: "haiku",
        },
        recallReadQueries: {
          getFtsHealth: () => ({
            healthy: false,
            transcriptReady: true,
            threadsReady: false,
            reason: "thread FTS missing or not backfilled",
          }),
          listTranscriptNeighborsBatch: () => [],
        },
      }),
    ).rejects.toBeInstanceOf(RecallRetrievalError);
    expect(store.searchThreads).not.toHaveBeenCalled();
  });

  it("does not turn a generic one-token fallback hit into a false match", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_map.md"),
      "# Memory map\n- unrelated work",
    );
    const store = makeStore() as any;
    store.searchTranscripts.mockReturnValue([
      {
        conversationId: "other",
        role: "user",
        atMs: 100,
        text: "A different project shipped successfully.",
      },
    ]);
    const records: Array<{ modelCalls: number; outcome: string }> = [];

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt:
        "Find the decision where Project Zephyr approved aquarium telemetry from Cassandra to CockroachDB.",
      memorySearchTerms: [
        "Project Zephyr",
        "aquarium telemetry",
        "Cassandra",
        "CockroachDB",
      ],
      stellaAppDir: root,
      stellaDataDir: root,
      store,
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
      onTelemetry: (record) => records.push(record),
    });

    expect(brief).toBe("Nothing relevant found.");
    expect(records[0]).toMatchObject({ outcome: "no-match", modelCalls: 0 });
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
  });

  it("requires anchors to co-occur inside one memory result", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_map.md"),
      [
        "# Memory map",
        "- alpha-anchor belongs to one unrelated entry",
        "  filler one",
        "  filler two",
        "  filler three",
        "  filler four",
        "  filler five",
        "- beta-anchor belongs to another unrelated entry",
      ].join("\n"),
    );
    const store = makeStore() as any;

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt: "What prior decision joined alpha-anchor and beta-anchor?",
      memorySearchTerms: ["alpha-anchor", "beta-anchor"],
      stellaAppDir: root,
      stellaDataDir: root,
      store,
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
    });

    expect(brief).toBe("Nothing relevant found.");
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
  });

  it("rejects partial phrase anchors even when generic tokens overlap", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_map.md"),
      [
        "# Memory map",
        "- Stella release verification covered a repository change.",
      ].join("\n"),
    );
    const store = makeStore() as any;

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt:
        "What are the established repo-scope and verification rules for Stella release sweeps?",
      memorySearchTerms: [
        "release sweep",
        "repo scope",
        "verification",
        "Stella",
      ],
      stellaAppDir: root,
      stellaDataDir: root,
      store,
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
    });

    expect(brief).toBe("Nothing relevant found.");
    expect(store.searchTranscripts).toHaveBeenCalledTimes(1);
  });

  it("returns an exact-phrase result directly and accepts reformulated terms", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "memories", "memory_map.md"),
      "# Memory map\n- banana protocol belongs to the orchard repo",
    );
    const records: Array<{ modelCalls: number; fastPath?: boolean }> = [];

    const brief = await runRecall({
      conversationId: "conv-1",
      lookupPrompt: "Find exact phrase banana protocol.",
      memorySearchTerms: ["wrong-alpha", "wrong-beta"],
      stellaAppDir: root,
      stellaDataDir: root,
      store: makeStore(),
      localEvents: [],
      recallRoute: {
        activeEngine: "default",
        executionEngine: "native",
        modelId: "test/light",
      } as never,
      recallReadQueries: {
        getFtsHealth: () => ({
          healthy: true,
          transcriptReady: true,
          threadsReady: true,
        }),
        listTranscriptNeighborsBatch: () => [],
      },
      onTelemetry: (record) => records.push(record),
    });

    expect(brief).toContain("banana protocol");
    expect(records[0]).toMatchObject({
      modelCalls: 0,
      fastPath: true,
      retrievalPasses: 2,
    });
  });

  it("classifies live, delegated, episodic, durable, and ambiguous intents deterministically", () => {
    expect(
      routeRecallIntent("What is on my active browser tab right now?"),
    ).toBe("live_context");
    expect(
      routeRecallIntent("Is the browser cleanup agent still running?"),
    ).toBe("delegated_work");
    expect(routeRecallIntent("When did I first drive the blue Lotus?")).toBe(
      "episodic",
    );
    expect(routeRecallIntent("What repo path did we decide for Stella?")).toBe(
      "durable_memory",
    );
    expect(routeRecallIntent("Tell me what we know about Zephyr")).toBe(
      "multi_source",
    );
    expect(routeRecallIntent("What file defines agent status?")).toBe(
      "multi_source",
    );
    expect(
      routeRecallIntent(
        "What prior decision set low reasoning for Recall and progress summaries?",
      ),
    ).toBe("durable_memory");
    expect(
      routeRecallIntent(
        "What are the prior orchestrator prompt rules for Recall and milestone status?",
      ),
    ).toBe("multi_source");
    expect(
      routeRecallIntent("Find this phrase right now in which old discussion"),
    ).toBe("multi_source");
    expect(routeRecallIntent("stella-v2")).toBe("durable_memory");
    expect(routeRecallIntent("Find exact phrase banana protocol")).toBe(
      "multi_source",
    );
    expect(
      classifyRecallIntent("Find exact phrase banana protocol"),
    ).toMatchObject({ deterministicFastPath: true });
    expect(
      classifyRecallIntent("When did I first drive the blue Lotus?"),
    ).toMatchObject({ deterministicFastPath: false });
    expect(
      classifyRecallIntent("What file defines agent status?"),
    ).toMatchObject({ deterministicFastPath: false });
    expect(
      isRecallNoMatchBrief("  NOTHING RELEVANT FOUND: after two passes"),
    ).toBe(true);
  });
});
