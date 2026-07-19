import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerApiProvider } from "../../../../../runtime/ai/api-registry.js";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from "../../../../../runtime/ai/types.js";
import {
  awaitPreCompactionConsolidation,
  buildDreamSystemPrompt,
  maybeSpawnDreamRun,
} from "../../../../../runtime/kernel/agent-runtime/dream-scheduler.js";
import type { ResolvedLlmRoute } from "../../../../../runtime/kernel/model-routing.js";
import type { RuntimeStore } from "../../../../../runtime/kernel/storage/runtime-store.js";

const activeRoots = new Set<string>();

const createRoot = (): string => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-dream-scheduler-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  activeRoots.add(rootPath);
  return rootPath;
};

afterEach(async () => {
  for (const rootPath of activeRoots) {
    await rm(rootPath, { recursive: true, force: true });
  }
  activeRoots.clear();
});

const fakeAssistant = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

const buildResultStream = (
  message: AssistantMessage,
): AssistantMessageEventStream =>
  ({
    result: async () => message,
  }) as AssistantMessageEventStream;

const buildFakeRoute = (args: {
  response: AssistantMessage;
  apiKey?: string;
  onRequest?: () => void;
}): ResolvedLlmRoute => {
  const apiId = `fake-${Math.random().toString(36).slice(2)}` as Api;
  registerApiProvider({
    api: apiId,
    stream: (
      _model: Model<Api>,
      _context: Context,
      _options?: StreamOptions,
    ) => {
      args.onRequest?.();
      return buildResultStream(args.response);
    },
    streamSimple: (
      _model: Model<Api>,
      _context: Context,
      _options?: SimpleStreamOptions,
    ) => {
      args.onRequest?.();
      return buildResultStream(args.response);
    },
  });
  const model = {
    id: "fake-model",
    name: "Fake Model",
    api: apiId,
    provider: "openai",
    baseUrl: "http://localhost:3210/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as unknown as Model<Api>;
  return {
    model,
    route: "direct-provider",
    getApiKey: () => args.apiKey ?? "",
  };
};

/** An API whose streams never settle — simulates a hung provider. */
const registerHangingApi = (): Api => {
  const apiId = `fake-hang-${Math.random().toString(36).slice(2)}` as Api;
  const hanging = () =>
    ({
      result: () => new Promise<AssistantMessage>(() => {}),
    }) as AssistantMessageEventStream;
  registerApiProvider({
    api: apiId,
    stream: hanging,
    streamSimple: hanging,
  });
  return apiId;
};

/** An API whose streams reject — simulates a provider failure. */
const registerFailingApi = (): Api => {
  const apiId = `fake-fail-${Math.random().toString(36).slice(2)}` as Api;
  const failing = () =>
    ({
      result: async () => {
        throw new Error("provider stream failed");
      },
    }) as AssistantMessageEventStream;
  registerApiProvider({
    api: apiId,
    stream: failing,
    streamSimple: failing,
  });
  return apiId;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("maybeSpawnDreamRun", () => {
  it("allows credentialless direct-provider routes to execute the Dream pass", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store: {
        dreamInboxStore: {
          countUnprocessed: () => 1,
        },
      } as RuntimeStore,
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("- Consolidated the current memory inputs."),
        onRequest: () => {
          providerCalls += 1;
        },
      }),
      trigger: "manual",
    });

    expect(result).toMatchObject({
      scheduled: true,
      reason: "scheduled",
      pendingItems: 1,
    });

    await waitFor(() => providerCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(providerCalls).toBe(1);
  });

  const pendingStore = (): RuntimeStore =>
    ({
      dreamInboxStore: { countUnprocessed: () => 1 },
    }) as RuntimeStore;

  it("skips token_interval runs below the growth threshold", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store: pendingStore(),
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("noop"),
        onRequest: () => {
          providerCalls += 1;
        },
      }),
      trigger: "token_interval",
      orchestratorTokenEstimate: 5_000,
    });

    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe("below_threshold");
    expect(providerCalls).toBe(0);
  });

  it("runs token_interval once growth crosses the interval", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store: pendingStore(),
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("- folded the interval batch"),
        onRequest: () => {
          providerCalls += 1;
        },
      }),
      trigger: "token_interval",
      orchestratorTokenEstimate: 25_000,
    });

    expect(result.scheduled).toBe(true);
    await waitFor(() => providerCalls > 0);
  });

  it("flushes on pre_compaction regardless of growth", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store: pendingStore(),
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("- flushed before compaction"),
        onRequest: () => {
          providerCalls += 1;
        },
      }),
      trigger: "pre_compaction",
      orchestratorTokenEstimate: 1_000,
    });

    expect(result.scheduled).toBe(true);
    await waitFor(() => providerCalls > 0);
  });

  it("returns no_inputs when nothing is pending, even at the compaction boundary", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store: {
        dreamInboxStore: { countUnprocessed: () => 0 },
      } as RuntimeStore,
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("noop"),
        onRequest: () => {
          providerCalls += 1;
        },
      }),
      trigger: "pre_compaction",
      orchestratorTokenEstimate: 100_000,
    });

    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe("no_inputs");
    expect(providerCalls).toBe(0);
  });
});

describe("buildDreamSystemPrompt (single prompt source)", () => {
  it("is complete without any installed home prompt and carries the map contract", () => {
    const rootPath = createRoot();
    const prompt = buildDreamSystemPrompt(rootPath);

    // Built-in fallback body: full behavioral instructions, not just rules.
    expect(prompt).toContain("You are the Dream agent for Stella");
    expect(prompt).toContain('action="markProcessed"');
    // Mechanically appended memory_map contract.
    expect(prompt).toContain("memory_map.md");
    expect(prompt).toContain("memory_summary.md and memory_index.md are RETIRED");
    expect(prompt).toContain("IS REJECTED");
    expect(prompt).toContain("DREAM:MAP_START / DREAM:MAP_END");
    expect(prompt).toContain("## Derived constraints");
    expect(prompt).toContain("never edit it");
  });

  it("keeps the synchronized home prompt as the base body while the map contract stays authoritative", async () => {
    const rootPath = createRoot();
    await mkdir(path.join(rootPath, "prompts"), { recursive: true });
    // A stale remote body that still mentions the retired summary file: the
    // appended contract must supersede it explicitly.
    await writeFile(
      path.join(rootPath, "prompts", "dream-scheduled.md"),
      "Custom scheduled Dream body.\nAfter folding rows, refresh memory_summary.md.",
      "utf-8",
    );

    const prompt = buildDreamSystemPrompt(rootPath);
    expect(prompt).toContain("Custom scheduled Dream body.");
    expect(prompt).not.toContain("You are the Dream agent for Stella");
    const contractIndex = prompt.indexOf(
      "memory_summary.md and memory_index.md are RETIRED",
    );
    expect(contractIndex).toBeGreaterThan(
      prompt.indexOf("Custom scheduled Dream body."),
    );
    expect(prompt).toContain("supersedes any earlier instructions");
  });
});

describe("awaitPreCompactionConsolidation (consolidate-before-compact)", () => {
  type FakeInbox = {
    countUnprocessed: () => number;
    pendingFrontier: () => number;
    readConsolidationWatermark: () =>
      | { frontier: number; completedAt: number }
      | null;
    writeConsolidationWatermark: (args: {
      frontier: number;
      completedAt?: number;
    }) => void;
  };

  const buildFakeStore = (args: {
    pending: number;
    frontier: number;
    watermark?: { frontier: number; completedAt: number } | null;
  }): { store: RuntimeStore; watermarkWrites: Array<{ frontier: number }> } => {
    const watermarkWrites: Array<{ frontier: number }> = [];
    const inbox: FakeInbox = {
      countUnprocessed: () => args.pending,
      pendingFrontier: () => args.frontier,
      readConsolidationWatermark: () => args.watermark ?? null,
      writeConsolidationWatermark: (write) => {
        watermarkWrites.push({ frontier: write.frontier });
      },
    };
    return {
      store: { dreamInboxStore: inbox } as unknown as RuntimeStore,
      watermarkWrites,
    };
  };

  it("skips fresh when nothing is pending, without spawning a run", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const { store } = buildFakeStore({ pending: 0, frontier: 0 });
    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("noop"),
        apiKey: "key",
        onRequest: () => {
          providerCalls += 1;
        },
      }),
    });
    expect(result.outcome).toBe("skipped_fresh");
    expect(providerCalls).toBe(0);
  });

  it("skips fresh when a completed pass already covers the pending frontier", async () => {
    const rootPath = createRoot();
    let providerCalls = 0;
    const { store } = buildFakeStore({
      pending: 3,
      frontier: 1_000,
      watermark: { frontier: 1_500, completedAt: Date.now() },
    });
    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("noop"),
        apiKey: "key",
        onRequest: () => {
          providerCalls += 1;
        },
      }),
    });
    expect(result.outcome).toBe("skipped_fresh");
    expect(providerCalls).toBe(0);
  });

  it("awaits a spawned pass to completion and advances the persisted watermark", async () => {
    const rootPath = createRoot();
    const { store, watermarkWrites } = buildFakeStore({
      pending: 2,
      frontier: 4_242,
    });
    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("Nothing to consolidate."),
        apiKey: "key",
      }),
    });
    expect(result.outcome).toBe("consolidated");
    expect(result.pendingItems).toBe(2);
    expect(watermarkWrites).toEqual([{ frontier: 4_242 }]);

    // With the watermark persisted at the frontier, the next boundary skips
    // the await outright even though rows are still marked pending.
    const second = await awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store: buildFakeStore({
        pending: 2,
        frontier: 4_242,
        watermark: { frontier: 4_242, completedAt: Date.now() },
      }).store,
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("noop"),
        apiKey: "key",
      }),
    });
    expect(second.outcome).toBe("skipped_fresh");
  });

  it("times out on a hung pass and returns without advancing the watermark", async () => {
    const rootPath = createRoot();
    const { store, watermarkWrites } = buildFakeStore({
      pending: 1,
      frontier: 9_000,
    });
    const hangingRoute = buildFakeRoute({
      response: fakeAssistant("never delivered"),
      apiKey: "key",
    });
    hangingRoute.model = {
      ...hangingRoute.model,
      api: registerHangingApi(),
    } as typeof hangingRoute.model;

    const startedAt = Date.now();
    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: hangingRoute,
      timeoutMs: 120,
    });
    expect(result.outcome).toBe("timed_out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(watermarkWrites).toEqual([]);
  });

  it("reports an incomplete pass (provider failure) and leaves the watermark alone", async () => {
    const rootPath = createRoot();
    const { store, watermarkWrites } = buildFakeStore({
      pending: 1,
      frontier: 7_000,
    });
    const failingRoute = buildFakeRoute({
      response: fakeAssistant("unused"),
      apiKey: "key",
    });
    failingRoute.model = {
      ...failingRoute.model,
      api: registerFailingApi(),
    } as typeof failingRoute.model;

    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: failingRoute,
    });
    expect(result.outcome).toBe("incomplete");
    expect(watermarkWrites).toEqual([]);
  });

  it("never throws even when the store is entirely broken", async () => {
    const rootPath = createRoot();
    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store: {
        get dreamInboxStore(): never {
          throw new Error("store exploded");
        },
      } as unknown as RuntimeStore,
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("noop"),
        apiKey: "key",
      }),
    });
    expect(result.outcome).toBe("skipped_fresh");
  });
});
