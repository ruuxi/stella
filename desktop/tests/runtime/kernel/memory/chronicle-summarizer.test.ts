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
  chronicleSummaryFilePath,
  runChronicleSummary,
  type ChronicleSummaryResult,
} from "../../../../../runtime/kernel/memory/chronicle-summarizer.js";
import type { ResolvedLlmRoute } from "../../../../../runtime/kernel/model-routing.js";

type TestContext = {
  rootPath: string;
};

type FakeRouteOptions = {
  route?: ResolvedLlmRoute["route"];
  apiKey?: string;
  baseUrl?: string;
  onRequest?: () => void;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-chronicle-summarizer-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  const ctx = { rootPath };
  activeContexts.add(ctx);
  return ctx;
};

afterEach(async () => {
  for (const ctx of activeContexts) {
    await rm(ctx.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

const writeCaptures = async (
  rootPath: string,
  entries: Array<{
    ts: string;
    addedLines: string[];
  }>,
): Promise<void> => {
  const dir = path.join(rootPath, "state", "chronicle");
  await mkdir(dir, { recursive: true });
  const lines = entries.map((entry) =>
    JSON.stringify({
      ts: entry.ts,
      displayId: "1",
      addedLines: entry.addedLines,
      removedLines: [],
    }),
  );
  await writeFile(
    path.join(dir, "captures.jsonl"),
    `${lines.join("\n")}\n`,
    "utf-8",
  );
};

const writeChronicleConfig = async (
  rootPath: string,
  enabled: boolean,
): Promise<void> => {
  const configPath = path.join(rootPath, "state", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ chronicle: { enabled } }, null, 2)}\n`,
    "utf-8",
  );
};

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

const buildFakeRoute = (
  response: AssistantMessage,
  options: FakeRouteOptions = {},
): ResolvedLlmRoute => {
  const apiId = `fake-${Math.random().toString(36).slice(2)}` as Api;
  registerApiProvider({
    api: apiId,
    stream: (
      _model: Model<Api>,
      _context: Context,
      _options?: StreamOptions,
    ) => {
      options.onRequest?.();
      return buildResultStream(response);
    },
    streamSimple: (
      _model: Model<Api>,
      _context: Context,
      _options?: SimpleStreamOptions,
    ) => {
      options.onRequest?.();
      return buildResultStream(response);
    },
  });
  const model = {
    id: "fake-model",
    name: "Fake Model",
    api: apiId,
    provider: "openai",
    baseUrl: options.baseUrl ?? "http://localhost:3210/v1",
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
    route: options.route ?? "direct-provider",
    getApiKey: () => options.apiKey ?? "fake-key",
  };
};

const expectWrote = (
  result: ChronicleSummaryResult,
): result is Extract<ChronicleSummaryResult, { wrote: true }> => {
  expect(result.wrote).toBe(true);
  return result.wrote === true;
};

const expectNotWrote = (
  result: ChronicleSummaryResult,
): result is Extract<ChronicleSummaryResult, { wrote: false }> => {
  expect(result.wrote).toBe(false);
  return result.wrote === false;
};

describe("chronicle-summarizer", () => {
  it("skips when no captures.jsonl exists", async () => {
    const { rootPath } = createTestContext();
    const result = await runChronicleSummary({
      stellaHome: rootPath,
      window: "10m",
      resolvedLlm: buildFakeRoute(fakeAssistant("- noise")),
    });
    if (expectNotWrote(result)) {
      expect(result.reason).toBe("no_captures");
    }
  });

  it("skips when Chronicle is disabled", async () => {
    const { rootPath } = createTestContext();
    const now = Date.now();
    await writeChronicleConfig(rootPath, false);
    await writeCaptures(rootPath, [
      {
        ts: new Date(now - 60_000).toISOString(),
        addedLines: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
      },
    ]);
    const result = await runChronicleSummary({
      stellaHome: rootPath,
      window: "10m",
      resolvedLlm: buildFakeRoute(fakeAssistant("- summary")),
    });
    if (expectNotWrote(result)) {
      expect(result.reason).toBe("disabled");
    }
  });

  it("skips when too few unique lines in window", async () => {
    const { rootPath } = createTestContext();
    const now = Date.now();
    await writeCaptures(rootPath, [
      {
        ts: new Date(now - 2 * 60_000).toISOString(),
        addedLines: ["only", "two"],
      },
    ]);
    const result = await runChronicleSummary({
      stellaHome: rootPath,
      window: "10m",
      resolvedLlm: buildFakeRoute(fakeAssistant("- summary")),
    });
    if (expectNotWrote(result)) {
      expect(result.reason).toBe("below_threshold");
      expect(result.uniqueLines).toBe(2);
    }
  });

  it("ignores entries outside the window", async () => {
    const { rootPath } = createTestContext();
    const now = Date.now();
    await writeCaptures(rootPath, [
      {
        ts: new Date(now - 30 * 60_000).toISOString(),
        addedLines: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
      },
      {
        ts: new Date(now - 60_000).toISOString(),
        addedLines: ["only one fresh line"],
      },
    ]);
    const result = await runChronicleSummary({
      stellaHome: rootPath,
      window: "10m",
      resolvedLlm: buildFakeRoute(fakeAssistant("- summary")),
    });
    if (expectNotWrote(result)) {
      expect(result.reason).toBe("below_threshold");
      expect(result.uniqueLines).toBe(1);
    }
  });

  it("respects NO_SIGNAL response and does not write a summary", async () => {
    const { rootPath } = createTestContext();
    const now = Date.now();
    await writeCaptures(rootPath, [
      {
        ts: new Date(now - 60_000).toISOString(),
        addedLines: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
      },
    ]);
    const result = await runChronicleSummary({
      stellaHome: rootPath,
      window: "10m",
      resolvedLlm: buildFakeRoute(fakeAssistant("NO_SIGNAL")),
    });
    if (expectNotWrote(result)) {
      expect(result.reason).toBe("no_signal");
    }
  });

  it("writes a summary file and ensures instructions when LLM returns content", async () => {
    const { rootPath } = createTestContext();
    const now = Date.now();
    await writeCaptures(rootPath, [
      {
        ts: new Date(now - 5 * 60_000).toISOString(),
        addedLines: [
          "Stella project README",
          "AGENTS.md heading",
          "deriveTurnResource helper",
          "PdfViewerCard react-pdf import",
          "vitest test runner",
        ],
      },
      {
        ts: new Date(now - 60_000).toISOString(),
        addedLines: [
          "chronicle-summarizer.ts new file",
          "memories_extensions",
        ],
      },
    ]);
    const summaryBody = "- User is editing Stella's chronicle pipeline";
    const result = await runChronicleSummary({
      stellaHome: rootPath,
      window: "10m",
      resolvedLlm: buildFakeRoute(fakeAssistant(summaryBody)),
    });

    if (expectWrote(result)) {
      expect(result.window).toBe("10m");
      expect(result.uniqueLines).toBeGreaterThanOrEqual(5);
      expect(result.outPath).toBe(chronicleSummaryFilePath(rootPath, "10m"));
    }

    const written = await readFile(
      chronicleSummaryFilePath(rootPath, "10m"),
      "utf-8",
    );
    expect(written).toContain("# Chronicle 10m summary");
    expect(written).toContain(summaryBody);

    const instructions = await readFile(
      path.join(
        rootPath,
        "state",
        "memories_extensions",
        "chronicle",
        "instructions.md",
      ),
      "utf-8",
    );
    expect(instructions).toContain("10m-current.md");
    expect(instructions).toContain("6h-current.md");
  });

  it("skips unchanged windows before making another LLM call", async () => {
    const { rootPath } = createTestContext();
    const now = Date.now();
    await writeCaptures(rootPath, [
      {
        ts: new Date(now - 2 * 60_000).toISOString(),
        addedLines: [
          "Stella README",
          "Dream agent prompt",
          "Chronicle OCR line",
          "memory watermark file",
          "vitest output",
          "runner trigger",
        ],
      },
    ]);
    let calls = 0;
    const route = buildFakeRoute(
      fakeAssistant("- User is working on the memory pipeline"),
      {
        onRequest: () => {
          calls += 1;
        },
      },
    );

    const first = await runChronicleSummary({
      stellaHome: rootPath,
      window: "10m",
      resolvedLlm: route,
    });
    expectWrote(first);
    expect(calls).toBe(1);

    const before = await readFile(
      chronicleSummaryFilePath(rootPath, "10m"),
      "utf-8",
    );
    const second = await runChronicleSummary({
      stellaHome: rootPath,
      window: "10m",
      resolvedLlm: route,
    });
    if (expectNotWrote(second)) {
      expect(second.reason).toBe("unchanged");
    }
    expect(calls).toBe(1);
    const after = await readFile(
      chronicleSummaryFilePath(rootPath, "10m"),
      "utf-8",
    );
    expect(after).toBe(before);
  });

  it("allows credentialless direct-provider routes when the provider has a base URL", async () => {
    const { rootPath } = createTestContext();
    const now = Date.now();
    await writeCaptures(rootPath, [
      {
        ts: new Date(now - 60_000).toISOString(),
        addedLines: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
      },
    ]);
    const result = await runChronicleSummary({
      stellaHome: rootPath,
      window: "10m",
      resolvedLlm: buildFakeRoute(fakeAssistant("- summary"), {
        route: "direct-provider",
        apiKey: "",
      }),
    });
    expectWrote(result);
  });

  it("returns no_api_key when the route still requires credentials", async () => {
    const { rootPath } = createTestContext();
    const now = Date.now();
    await writeCaptures(rootPath, [
      {
        ts: new Date(now - 60_000).toISOString(),
        addedLines: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
      },
    ]);
    const result = await runChronicleSummary({
      stellaHome: rootPath,
      window: "10m",
      resolvedLlm: buildFakeRoute(fakeAssistant("ignored"), {
        route: "stella",
        apiKey: "",
      }),
    });
    if (expectNotWrote(result)) {
      expect(result.reason).toBe("no_api_key");
    }
  });
});
