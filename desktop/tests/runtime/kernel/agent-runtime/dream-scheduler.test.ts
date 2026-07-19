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
