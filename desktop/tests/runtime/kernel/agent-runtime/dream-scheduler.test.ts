import { rm } from "node:fs/promises";
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
import { maybeSpawnDreamRun } from "../../../../../runtime/kernel/agent-runtime/dream-scheduler.js";
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
      stellaHome: rootPath,
      store: {
        memoryStore: {},
        threadSummariesStore: {
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
      pendingThreadSummaries: 1,
      pendingExtensions: 0,
    });

    await waitFor(() => providerCalls > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(providerCalls).toBe(1);
  });
});
