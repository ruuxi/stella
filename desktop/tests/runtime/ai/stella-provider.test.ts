import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleStella } from "../../../runtime/ai/providers/stella.js";
import type { AssistantMessage, Context, Model } from "../../../runtime/ai/types.js";
import {
  normalizeStellaSiteUrl,
  stellaRuntimeUrlFromSiteUrl,
} from "../../../src/shared/stella-api.js";

const createModel = (): Model<"stella"> => ({
  id: "stella/default",
  name: "Stella Recommended",
  api: "stella",
  provider: "stella",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 16_384,
  headers: {
    "X-Stella-Agent-Type": "general",
  },
});

const createContext = (): Context => ({
  messages: [{
    role: "user",
    content: "Inspect the task",
    timestamp: 1_000,
  }],
});

const readFinalMessage = async (api: "openai-responses" | "openai-completions") => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(
      [
        `data: ${JSON.stringify({
          type: "start",
          api,
          provider: api === "openai-responses" ? "openrouter" : "managed",
          model: api === "openai-responses" ? "openai/gpt-5.4" : "qwen/qwen3-coder",
        })}`,
        "",
        'data: {"type":"thinking_start","contentIndex":0}',
        "",
        'data: {"type":"thinking_delta","contentIndex":0,"delta":"Need to inspect the task."}',
        "",
        'data: {"type":"thinking_end","contentIndex":0,"contentSignature":"{\\"type\\":\\"reasoning\\",\\"id\\":\\"rs_123\\"}"}',
        "",
        'data: {"type":"text_start","contentIndex":1}',
        "",
        'data: {"type":"text_delta","contentIndex":1,"delta":"Done."}',
        "",
        'data: {"type":"text_end","contentIndex":1,"contentSignature":"{\\"v\\":1,\\"id\\":\\"msg_123\\"}"}',
        "",
        'data: {"type":"done","reason":"stop","usage":{"input":12,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":17,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}',
        "",
      ].join("\n"),
      {
        headers: {
          "Content-Type": "text/event-stream",
        },
      },
    )));

  const stream = streamSimpleStella(createModel(), createContext(), { apiKey: "token" });
  let finalMessage: AssistantMessage | null = null;
  for await (const event of stream) {
    if (event.type === "done") {
      finalMessage = event.message;
    }
  }

  expect(finalMessage).not.toBeNull();
  return finalMessage as AssistantMessage;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("streamSimpleStella", () => {
  it("normalizes Stella URLs back to the site root and derives runtime in one place", () => {
    expect(normalizeStellaSiteUrl("https://example.test/api/stella/v1")).toBe(
      "https://example.test",
    );
    expect(normalizeStellaSiteUrl("https://example.test/api/stella/v1/runtime")).toBe(
      "https://example.test",
    );
    expect(normalizeStellaSiteUrl("https://example.test/api/stella/v1/chat/completions")).toBe(
      "https://example.test",
    );
    expect(stellaRuntimeUrlFromSiteUrl("https://example.test/api/stella/v1")).toBe(
      "https://example.test/api/stella/v1/runtime",
    );
  });

  it("preserves responses reasoning signatures and resolved model metadata", async () => {
    const message = await readFinalMessage("openai-responses");

    expect(message).toMatchObject({
      api: "openai-responses",
      provider: "openrouter",
      model: "openai/gpt-5.4",
      usage: {
        input: 12,
        output: 5,
        totalTokens: 17,
      },
    });
    expect(message.content).toEqual([
      {
        type: "thinking",
        thinking: "Need to inspect the task.",
        thinkingSignature: '{"type":"reasoning","id":"rs_123"}',
      },
      {
        type: "text",
        text: "Done.",
        textSignature: '{"v":1,"id":"msg_123"}',
      },
    ]);
  });

  it("preserves completions reasoning deltas in the same native assistant shape", async () => {
    const message = await readFinalMessage("openai-completions");

    expect(message).toMatchObject({
      api: "openai-completions",
      provider: "managed",
      model: "qwen/qwen3-coder",
    });
    expect(message.content[0]).toEqual({
      type: "thinking",
      thinking: "Need to inspect the task.",
      thinkingSignature: '{"type":"reasoning","id":"rs_123"}',
    });
  });
});
