import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  runDreamDeltaShadow,
} from "../../../../../runtime/kernel/agent-runtime/dream-scheduler.js";
import type { DreamDeltaSourceMessage } from "../../../../../runtime/kernel/agent-runtime/dream-delta.js";
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

  it("advances the watermark only to what the pass actually consumed on a >limit backlog", async () => {
    const rootPath = createRoot();
    const watermarkWrites: Array<{ frontier: number }> = [];
    const store = {
      dreamInboxStore: {
        countUnprocessed: () => 60,
        pendingFrontier: () => 9_999,
        readConsolidationWatermark: () => null,
        writeConsolidationWatermark: (write: { frontier: number }) => {
          watermarkWrites.push({ frontier: write.frontier });
        },
        // The pass only consumed rows up to 7_000 (LIST-limit backlog).
        maxProcessedSourceUpdatedAtSince: () => 7_000,
      },
    } as unknown as RuntimeStore;
    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("folded a batch"),
        apiKey: "key",
      }),
    });
    expect(result.outcome).toBe("consolidated");
    expect(watermarkWrites).toEqual([{ frontier: 7_000 }]);
  });

  it("does not advance the watermark when a completed pass consumed nothing", async () => {
    const rootPath = createRoot();
    const watermarkWrites: Array<{ frontier: number }> = [];
    const store = {
      dreamInboxStore: {
        countUnprocessed: () => 3,
        pendingFrontier: () => 5_000,
        readConsolidationWatermark: () => null,
        writeConsolidationWatermark: (write: { frontier: number }) => {
          watermarkWrites.push({ frontier: write.frontier });
        },
        maxProcessedSourceUpdatedAtSince: () => 0,
      },
    } as unknown as RuntimeStore;
    const result = await awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: buildFakeRoute({
        response: fakeAssistant("Nothing to consolidate."),
        apiKey: "key",
      }),
    });
    expect(result.outcome).toBe("consolidated");
    expect(watermarkWrites).toEqual([]);
  });

  it("skips the wait entirely once a boundary already timed out on the same hung pass", async () => {
    const rootPath = createRoot();
    const { store } = buildFakeStore({ pending: 1, frontier: 9_000 });
    const hangingRoute = buildFakeRoute({
      response: fakeAssistant("never delivered"),
      apiKey: "key",
    });
    hangingRoute.model = {
      ...hangingRoute.model,
      api: registerHangingApi(),
    } as typeof hangingRoute.model;

    const first = await awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: hangingRoute,
      timeoutMs: 100,
    });
    expect(first.outcome).toBe("timed_out");

    // Same pass still hung: the next boundary must not pay the timeout again.
    const startedAt = Date.now();
    const second = await awaitPreCompactionConsolidation({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: hangingRoute,
      timeoutMs: 60_000,
    });
    expect(second.outcome).toBe("not_started");
    expect(second.detail).toContain("already timed out");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("orchestrator-delta staging (migration step 6)", () => {
  const CONVERSATION_ID = "conv-orchestrator";

  const userMsg = (ts: number, text: string): DreamDeltaSourceMessage => ({
    timestamp: ts,
    role: "user",
    content: text,
    payload: {
      role: "user",
      content: text,
      timestamp: ts,
    } as DreamDeltaSourceMessage["payload"],
  });

  /** Route whose provider records every request context and answers from a
   * queue (last response repeats), so the Dream pass and the shadow pass can
   * be told apart by their prompts. */
  const buildRecordingRoute = (
    responses: string[],
  ): { route: ResolvedLlmRoute; contexts: Context[] } => {
    const contexts: Context[] = [];
    const apiId = `fake-rec-${Math.random().toString(36).slice(2)}` as Api;
    const answer = (context: Context): AssistantMessageEventStream => {
      contexts.push(context);
      const text =
        responses[Math.min(contexts.length - 1, responses.length - 1)] ?? "ok";
      return buildResultStream(fakeAssistant(text));
    };
    registerApiProvider({
      api: apiId,
      stream: (_model: Model<Api>, context: Context, _options?: StreamOptions) =>
        answer(context),
      streamSimple: (
        _model: Model<Api>,
        context: Context,
        _options?: SimpleStreamOptions,
      ) => answer(context),
    });
    const base = buildFakeRoute({ response: fakeAssistant("unused") });
    return {
      route: {
        ...base,
        model: { ...base.model, api: apiId } as typeof base.model,
      },
      contexts,
    };
  };

  type DeltaStoreArgs = {
    pending?: number;
    frontier?: number;
    watermark?: number;
    messages?: DreamDeltaSourceMessage[];
  };

  const buildDeltaStore = (args: DeltaStoreArgs) => {
    const advances: Array<{ conversationId: string; ts: number }> = [];
    const markCalls: Array<{
      conversationId: string;
      kinds: readonly string[];
      throughTs: number;
    }> = [];
    let watermark = args.watermark ?? 0;
    const store = {
      dreamInboxStore: {
        countUnprocessed: () => args.pending ?? 0,
        pendingFrontier: () => args.frontier ?? 0,
        readConsolidationWatermark: () => null,
        writeConsolidationWatermark: () => {},
        maxProcessedSourceUpdatedAtSince: () => 0,
        readDeltaWatermark: () => watermark,
        advanceDeltaWatermark: (conversationId: string, ts: number) => {
          advances.push({ conversationId, ts });
          watermark = Math.max(watermark, ts);
        },
        markKindsProcessedThrough: (call: {
          conversationId: string;
          kinds: readonly string[];
          throughTs: number;
        }) => {
          markCalls.push(call);
          return { updated: 0 };
        },
      },
      loadRawThreadMessagesWithEntryTypes: () => args.messages ?? [],
    } as unknown as RuntimeStore;
    return { store, advances, markCalls };
  };

  it("runs the delta derivation in shadow after a completed inbox pass", async () => {
    const rootPath = createRoot();
    const { route, contexts } = buildRecordingRoute([
      "- folded the inbox rows",
      "## Proposed MEMORY.md blocks\n- shadow proposal marker",
    ]);
    const { store, advances } = buildDeltaStore({
      pending: 1,
      watermark: 1_000,
      messages: [userMsg(2_000, "please remember I deploy on Fridays")],
    });

    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: route,
      trigger: "manual",
      conversationId: CONVERSATION_ID,
    });
    expect(result.scheduled).toBe(true);

    await waitFor(() => contexts.length >= 2, 3_000);
    await waitFor(() => advances.length > 0, 3_000);

    // The second request is the shadow derivation, on the delta transcript.
    expect(contexts[1]?.systemPrompt).toContain("SHADOW mode");
    const shadowUserText = JSON.stringify(contexts[1]?.messages ?? []);
    expect(shadowUserText).toContain("ORCHESTRATOR DELTA");
    expect(shadowUserText).toContain("deploy on Fridays");

    // Proposal recorded to the shadow log; watermark covers the delta.
    expect(advances).toEqual([
      { conversationId: CONVERSATION_ID, ts: 2_000 },
    ]);
    const shadowLog = await readFile(
      path.join(rootPath, "memories", "memory_shadow.md"),
      "utf-8",
    );
    expect(shadowLog).toContain("DREAM:SHADOW_PASS");
    expect(shadowLog).toContain("shadow proposal marker");
    expect(shadowLog).toContain(CONVERSATION_ID);
  });

  it("bootstraps a zero watermark without deriving or writing a shadow entry", async () => {
    const rootPath = createRoot();
    const { route, contexts } = buildRecordingRoute(["- folded the rows"]);
    const { store, advances } = buildDeltaStore({
      pending: 1,
      watermark: 0,
      messages: [userMsg(2_000, "pre-migration history")],
    });

    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: route,
      trigger: "manual",
      conversationId: CONVERSATION_ID,
    });
    expect(result.scheduled).toBe(true);

    await waitFor(() => advances.length > 0, 3_000);
    expect(advances).toEqual([
      { conversationId: CONVERSATION_ID, ts: 2_000 },
    ]);
    // Only the inbox pass hit the provider; nothing was derived.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(contexts.length).toBe(1);
    await expect(
      readFile(path.join(rootPath, "memories", "memory_shadow.md"), "utf-8"),
    ).rejects.toThrow();
  });

  it("honors dream.deltaShadow: false", async () => {
    const rootPath = createRoot();
    await mkdir(rootPath, { recursive: true });
    await writeFile(
      path.join(rootPath, "config.json"),
      JSON.stringify({ dream: { deltaShadow: false } }),
      "utf-8",
    );
    const { route, contexts } = buildRecordingRoute(["- folded the rows"]);
    const { store, advances } = buildDeltaStore({
      pending: 1,
      watermark: 1_000,
      messages: [userMsg(2_000, "some new turn")],
    });

    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: route,
      trigger: "manual",
      conversationId: CONVERSATION_ID,
    });
    expect(result.scheduled).toBe(true);
    await waitFor(() => contexts.length >= 1, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(contexts.length).toBe(1);
    expect(advances).toEqual([]);
  });

  it("cuts the pass input over to the orchestrator delta with dream.inputSource: delta", async () => {
    const rootPath = createRoot();
    await mkdir(rootPath, { recursive: true });
    await writeFile(
      path.join(rootPath, "config.json"),
      JSON.stringify({ dream: { inputSource: "delta" } }),
      "utf-8",
    );
    const { route, contexts } = buildRecordingRoute([
      "Folded the delta into MEMORY.md.",
    ]);
    const { store, advances, markCalls } = buildDeltaStore({
      pending: 1,
      watermark: 1_000,
      messages: [userMsg(2_000, "the delta is the input now")],
    });

    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: route,
      trigger: "manual",
      conversationId: CONVERSATION_ID,
    });
    expect(result.scheduled).toBe(true);

    await waitFor(() => advances.length > 0, 3_000);
    // Primary input is the delta transcript, not the inbox listing.
    const passUserText = JSON.stringify(contexts[0]?.messages ?? []);
    expect(passUserText).toContain("ORCHESTRATOR DELTA");
    expect(passUserText).toContain("the delta is the input now");
    // Clean completion: watermark advanced; mechanical consumption is
    // scoped to the delta's own conversation (never other conversations'
    // rows — reviewer finding 1).
    expect(advances).toEqual([
      { conversationId: CONVERSATION_ID, ts: 2_000 },
    ]);
    expect(markCalls).toEqual([
      {
        conversationId: CONVERSATION_ID,
        kinds: ["thread_summary", "memory_note"],
        throughTs: 2_000,
      },
    ]);
    // No shadow in delta mode — the delta IS the live input.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(contexts.length).toBe(1);
  });

  it("delta mode is eligible on a drained inbox when unconsolidated delta exists", async () => {
    const rootPath = createRoot();
    await mkdir(rootPath, { recursive: true });
    await writeFile(
      path.join(rootPath, "config.json"),
      JSON.stringify({ dream: { inputSource: "delta" } }),
      "utf-8",
    );
    const { route } = buildRecordingRoute(["Folded the delta."]);
    const { store, advances } = buildDeltaStore({
      pending: 0,
      watermark: 1_000,
      messages: [userMsg(2_000, "new material")],
    });

    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: route,
      trigger: "manual",
      conversationId: CONVERSATION_ID,
    });
    expect(result.scheduled).toBe(true);
    await waitFor(() => advances.length > 0, 3_000);
  });

  it("keeps no_inputs semantics for a drained inbox in the default input mode", async () => {
    const rootPath = createRoot();
    const { route, contexts } = buildRecordingRoute(["noop"]);
    const { store } = buildDeltaStore({
      pending: 0,
      watermark: 1_000,
      messages: [userMsg(2_000, "unconsolidated but inbox mode")],
    });
    const result = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: route,
      trigger: "manual",
      conversationId: CONVERSATION_ID,
    });
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe("no_inputs");
    expect(contexts.length).toBe(0);
  });

  it("bounds the shadow derivation: a hung LLM call times out, releases the single-flight, and leaves the watermark alone", async () => {
    const rootPath = createRoot();
    const { store, advances } = buildDeltaStore({
      watermark: 1_000,
      messages: [userMsg(2_000, "material for the shadow")],
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
    const timedOut = await runDreamDeltaShadow({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: hangingRoute,
      conversationId: CONVERSATION_ID,
      liveMemoryChanged: false,
      liveMapChanged: false,
      timeoutMs: 100,
    });
    expect(timedOut).toBe("timed_out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(advances).toEqual([]);
    await expect(
      readFile(path.join(rootPath, "memories", "memory_shadow.md"), "utf-8"),
    ).rejects.toThrow();

    // The single-flight guard was released: the next shadow proceeds and
    // covers the window the abandoned call left behind.
    const { route } = buildRecordingRoute([
      "## Proposed MEMORY.md blocks\n- recovered after timeout",
    ]);
    const recovered = await runDreamDeltaShadow({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: route,
      conversationId: CONVERSATION_ID,
      liveMemoryChanged: false,
      liveMapChanged: false,
    });
    expect(recovered).toBe("completed");
    expect(advances).toEqual([{ conversationId: CONVERSATION_ID, ts: 2_000 }]);
    const shadowLog = await readFile(
      path.join(rootPath, "memories", "memory_shadow.md"),
      "utf-8",
    );
    expect(shadowLog).toContain("recovered after timeout");
  });

  it("hydrates the persisted token baseline so a restart cannot fire a spurious interval pass", async () => {
    const rootPath = createRoot();
    const baselineWrites: number[] = [];
    const store = {
      dreamInboxStore: {
        countUnprocessed: () => 1,
        readTokenBaseline: () => 20_000,
        writeTokenBaseline: (tokens: number) => {
          baselineWrites.push(tokens);
        },
      },
    } as unknown as RuntimeStore;
    const { route, contexts } = buildRecordingRoute(["- folded"]);

    // Fresh process state + persisted baseline 20k: an estimate of 25k is
    // only 5k of growth — below the 20k interval, so no pass fires. Without
    // hydration this would have measured 25k growth from zero and fired.
    const below = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: route,
      trigger: "token_interval",
      orchestratorTokenEstimate: 25_000,
    });
    expect(below.scheduled).toBe(false);
    expect(below.reason).toBe("below_threshold");
    expect(contexts.length).toBe(0);

    // Real growth past the interval still fires, and the new baseline is
    // persisted for the next restart.
    const fired = await maybeSpawnDreamRun({
      stellaDataDir: rootPath,
      store,
      resolvedLlm: route,
      trigger: "token_interval",
      orchestratorTokenEstimate: 45_000,
    });
    expect(fired.scheduled).toBe(true);
    await waitFor(() => baselineWrites.includes(45_000), 3_000);
  });
});
