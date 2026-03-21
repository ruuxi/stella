import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import { getWelcomeSuggestionsText } from "../convex/http_routes/synthesis";
import {
  buildContextFromChatMessages,
  usageSummaryFromAssistant,
} from "../convex/runtime_ai/managed";
import {
  buildOpenAICompletionsParams,
  mapStopReason,
} from "../convex/runtime_ai/openai_completions";
import type { AssistantMessage, Model } from "../convex/runtime_ai/types";

const TEST_MODEL: Model<"openai-completions"> = {
  id: "openai/gpt-5.4",
  name: "openai/gpt-5.4",
  api: "openai-completions",
  provider: "managed",
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 32_000,
};

describe("runtime ai regressions", () => {
  test("welcome suggestions fallback stays null-safe", () => {
    expect(getWelcomeSuggestionsText(null)).toBe("");

    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[\"One idea\"]" }],
      api: "openai-completions",
      provider: "managed",
      model: "openai/gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    expect(getWelcomeSuggestionsText({ result: message })).toBe("[\"One idea\"]");
  });

  test("remote image urls survive chat context remapping", () => {
    const context = buildContextFromChatMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: {
              url: "https://example.com/cat.png",
              detail: "high",
            },
          },
        ],
      },
    ]);

    const params = buildOpenAICompletionsParams(TEST_MODEL, context, undefined, false) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMessage = params.messages.find((message) => message.role === "user");

    expect(userMessage).toBeDefined();
    expect(userMessage?.content).toEqual([
      { type: "text", text: "What is in this image?" },
      {
        type: "image_url",
        image_url: {
          url: "https://example.com/cat.png",
          detail: "high",
        },
      },
    ]);
  });

  test("chat context preserves in-band system and developer message order", () => {
    const context = buildContextFromChatMessages([
      { role: "system", content: "First rule." },
      { role: "user", content: "Question one." },
      { role: "developer", content: "Correction after user." },
      { role: "assistant", content: "Answer one." },
    ]);

    expect(context.systemPrompt).toBeUndefined();
    expect(context.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "developer",
      "assistant",
    ]);
  });

  test("chat context preserves single-space placeholder user messages", () => {
    const context = buildContextFromChatMessages([
      { role: "user", content: " " },
    ]);

    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: " " }],
    });
  });

  test("chat context preserves empty tool-result messages", () => {
    const context = buildContextFromChatMessages([
      {
        role: "assistant",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "lookup_weather",
            arguments: "{\"city\":\"Phoenix\"}",
          },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "lookup_weather",
        content: "",
      },
    ]);

    expect(context.messages).toHaveLength(2);
    expect(context.messages[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "lookup_weather",
      content: [{ type: "text", text: "" }],
    });
  });

  test("response_format is forwarded into chat completion params", () => {
    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "answer",
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
          },
          required: ["ok"],
        },
      },
    };

    const params = buildOpenAICompletionsParams(
      TEST_MODEL,
      {
        messages: [{
          role: "user",
          content: "Return JSON.",
          timestamp: Date.now(),
        }],
      },
      { responseFormat },
      false,
    ) as Record<string, unknown>;

    expect(params.response_format).toEqual(responseFormat);
  });

  test("reasoning tokens are preserved in usage summaries", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      api: "openai-completions",
      provider: "managed",
      model: "openai/gpt-5.4",
      usage: {
        input: 100,
        output: 80,
        cacheRead: 12,
        cacheWrite: 0,
        reasoningTokens: 35,
        totalTokens: 192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    expect(usageSummaryFromAssistant(message)).toEqual({
      inputTokens: 100,
      outputTokens: 80,
      totalTokens: 192,
      cachedInputTokens: 12,
      cacheWriteInputTokens: 0,
      reasoningTokens: 35,
    });
  });

  test("cached prompt tokens stay inside input token totals", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Cached." }],
      api: "openai-completions",
      provider: "managed",
      model: "openai/gpt-5.4",
      usage: {
        input: 112,
        output: 24,
        cacheRead: 12,
        cacheWrite: 4,
        reasoningTokens: 0,
        totalTokens: 136,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    expect(usageSummaryFromAssistant(message)).toEqual({
      inputTokens: 112,
      outputTokens: 24,
      totalTokens: 136,
      cachedInputTokens: 12,
      cacheWriteInputTokens: 4,
      reasoningTokens: 0,
    });
  });

  test("extra OpenAI-compatible request fields are preserved", () => {
    const params = buildOpenAICompletionsParams(
      TEST_MODEL,
      {
        messages: [{
          role: "user",
          content: "Return JSON.",
          timestamp: Date.now(),
        }],
      },
      {
        extraBody: {
          top_p: 0.2,
          seed: 42,
          parallel_tool_calls: false,
        },
      },
      false,
    ) as Record<string, unknown>;

    expect(params.top_p).toBe(0.2);
    expect(params.seed).toBe(42);
    expect(params.parallel_tool_calls).toBe(false);
  });

  test("strict tool schemas are preserved in OpenAI completions params", () => {
    const params = buildOpenAICompletionsParams(
      TEST_MODEL,
      {
        messages: [{
          role: "user",
          content: "Use the tool.",
          timestamp: Date.now(),
        }],
        tools: [{
          name: "lookup_weather",
          description: "Lookup weather",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              city: { type: "string" },
            },
            required: ["city"],
          },
          strict: true,
        }],
      },
      undefined,
      false,
    ) as {
      tools: Array<{ function: { strict?: boolean } }>;
    };

    expect(params.tools?.[0]?.function.strict).toBe(true);
  });

  test("non-standard finish reasons remain error states", () => {
    expect(mapStopReason("content_filter")).toBe("stop");
    expect(mapStopReason("unexpected_finish_reason")).toBe("error");
  });

  test("stella request passthrough keeps local agentType out of upstream payloads", () => {
    const source = readFileSync(
      path.resolve(import.meta.dir, "../convex/stella_provider.ts"),
      "utf-8",
    );

    expect(source).toContain('"agentType"');
  });

  test("stella usage adapter does not add cached prompt tokens twice", () => {
    const source = readFileSync(
      path.resolve(import.meta.dir, "../convex/stella_provider.ts"),
      "utf-8",
    );

    expect(source).toContain("const promptTokens = args.inputTokens;");
    expect(source).toContain("prompt_tokens_details");
    expect(source).toContain("cached_tokens: args.cachedInputTokens");
    expect(source).toContain("completion_tokens_details");
    expect(source).toContain("reasoning_tokens: args.reasoningTokens");
  });

  test("stella preserves upstream 4xx statuses for managed completion errors", () => {
    const source = readFileSync(
      path.resolve(import.meta.dir, "../convex/stella_provider.ts"),
      "utf-8",
    );

    expect(source).toContain("function toUpstreamHttpError");
    expect(source).toContain("upstreamHttpError?.status ?? 502");
    expect(source).toContain("function toUpstreamHttpErrorFromMessage");
  });

  test("stella streaming preflights to preserve upstream validation statuses", () => {
    const source = readFileSync(
      path.resolve(import.meta.dir, "../convex/stella_provider.ts"),
      "utf-8",
    );

    expect(source).toContain("const prefetched = await iterator.next();");
    expect(source).toContain("toUpstreamHttpErrorFromMessage(errorMessage)");
  });

  test("stella streaming errors emit parser-visible choice chunks", () => {
    const source = readFileSync(
      path.resolve(import.meta.dir, "../convex/stella_provider.ts"),
      "utf-8",
    );

    expect(source).toContain('finish_reason: "error"');
    expect(source).toContain('object: "chat.completion.chunk"');
  });

  test("stella streaming adapter forwards reasoning deltas", () => {
    const source = readFileSync(
      path.resolve(import.meta.dir, "../convex/stella_provider.ts"),
      "utf-8",
    );

    expect(source).toContain('event.type === "thinking_delta"');
    expect(source).toContain("reasoning_content: event.delta");
  });
});
