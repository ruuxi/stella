import { describe, expect, it } from "bun:test";

import {
  processResponsesStream,
  convertResponsesMessages,
  normalizeOpenAIFunctionName,
} from "../../../../backend/convex/runtime_ai/openai_responses_shared";
import { AssistantMessageEventStream } from "../../../../backend/convex/runtime_ai/event_stream";
import type {
  AssistantMessage,
  Context,
  Model,
} from "../../../../backend/convex/runtime_ai/types";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const makeModel = (provider: string): Model<"openai-responses"> => ({
  id: provider === "fireworks"
    ? "accounts/fireworks/models/kimi-k2p6"
    : "gpt-5.5",
  name: provider,
  api: "openai-responses",
  provider,
  baseUrl: provider === "fireworks"
    ? "https://api.fireworks.ai/inference/v1"
    : "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
});

const assistantMessage: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Previous assistant text." }],
  api: "openai-responses",
  provider: "fireworks",
  model: "accounts/fireworks/models/kimi-k2p6",
  usage,
  stopReason: "stop",
  timestamp: 1,
};

const context: Context = {
  messages: [
    { role: "user", content: "Earlier user text.", timestamp: 0 },
    assistantMessage,
    { role: "user", content: "Next user text.", timestamp: 2 },
  ],
};

describe("backend OpenAI Responses function names", () => {
  it("keeps canonical underscore tool names unchanged", () => {
    expect(normalizeOpenAIFunctionName("multi_tool_use_parallel")).toBe(
      "multi_tool_use_parallel",
    );
  });

  it("migrates the legacy dotted parallel tool name", () => {
    expect(normalizeOpenAIFunctionName("multi_tool_use.parallel")).toBe(
      "multi_tool_use_parallel",
    );
  });

  it("rejects unknown invalid tool names instead of silently rewriting them", () => {
    expect(() => normalizeOpenAIFunctionName("some.tool")).toThrow(
      "Invalid OpenAI Responses function name",
    );
  });
});

describe("backend OpenAI Responses message conversion", () => {
  it("does not replay Fireworks assistant history as output_text items", () => {
    const converted = convertResponsesMessages(
      makeModel("fireworks"),
      context,
      new Set(["openai", "openai-codex", "opencode"]),
    );

    expect(converted).toContainEqual({
      role: "assistant",
      content: [{ type: "input_text", text: "Previous assistant text." }],
    });
    expect(JSON.stringify(converted)).not.toContain("output_text");
  });

  it("keeps output_text replay for OpenAI Responses models", () => {
    const openaiContext: Context = {
      messages: [
        {
          ...assistantMessage,
          provider: "openai",
          model: "gpt-5.5",
        },
      ],
    };
    const converted = convertResponsesMessages(
      makeModel("openai"),
      openaiContext,
      new Set(["openai", "openai-codex", "opencode"]),
    );

    expect(JSON.stringify(converted)).toContain("output_text");
  });
});

describe("backend OpenAI Responses stream conversion", () => {
  it("streams text deltas even when output_text.delta arrives before output_item.added", async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "fireworks",
      model: "accounts/fireworks/models/kimi-k2p6",
      usage,
      stopReason: "stop",
      timestamp: 1,
    };
    const stream = new AssistantMessageEventStream();
    const events = [
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      { type: "response.output_text.done", text: "Hello world" },
      { type: "response.completed", response: { status: "completed" } },
    ];
    const seen: string[] = [];

    const reader = (async () => {
      for await (const event of stream) {
        if (event.type === "text_delta") {
          seen.push(event.delta);
        }
      }
    })();
    await processResponsesStream(
      events as Parameters<typeof processResponsesStream>[0],
      output,
      stream,
      makeModel("fireworks"),
    );
    stream.end();
    await reader;

    expect(seen).toEqual(["Hel", "lo", " world"]);
    expect(output.content).toEqual([{ type: "text", text: "Hello world" }]);
  });
});
