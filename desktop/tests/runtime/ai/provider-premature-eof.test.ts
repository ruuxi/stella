import { afterEach, describe, expect, it, vi } from "vitest";

import { readAssistantText } from "../../../../runtime/ai/stream.js";
import { streamAzureOpenAIResponses } from "../../../../runtime/ai/providers/azure-openai-responses.js";
import { streamOpenAICodexResponses } from "../../../../runtime/ai/providers/openai-codex-responses.js";
import { streamSimpleOpenAICompletions } from "../../../../runtime/ai/providers/openai-completions.js";
import type { Model } from "../../../../runtime/ai/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const prematureEventStream = (events: unknown[]): Response =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );

describe("provider premature EOF terminal semantics", () => {
  it("returns an error for OpenAI Completions text without finish_reason", async () => {
    globalThis.fetch = vi.fn(async () =>
      prematureEventStream([
        {
          id: "chatcmpl-partial",
          object: "chat.completion.chunk",
          created: 1,
          model: "partial-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "partial summary text" },
              finish_reason: null,
            },
          ],
        },
      ]),
    ) as typeof fetch;

    const model: Model<"openai-completions"> = {
      id: "partial-model",
      name: "Partial model",
      api: "openai-completions",
      provider: "custom",
      baseUrl: "https://completion.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };

    const result = await streamSimpleOpenAICompletions(
      model,
      { messages: [] },
      { apiKey: "test-key" },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(readAssistantText(result)).toBe("partial summary text");
  });

  it("returns an error for Azure Responses text without a terminal event", async () => {
    globalThis.fetch = vi.fn(async () =>
      prematureEventStream([
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          item_id: "message-partial",
          output_index: 0,
          content_index: 0,
          delta: "partial azure summary",
        },
      ]),
    ) as typeof fetch;

    const model: Model<"azure-openai-responses"> = {
      id: "azure-deployment",
      name: "Azure deployment",
      api: "azure-openai-responses",
      provider: "azure-openai-responses",
      baseUrl: "https://azure.test/openai/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };

    const result = await streamAzureOpenAIResponses(
      model,
      { messages: [] },
      {
        apiKey: "test-key",
        azureBaseUrl: "https://azure.test/openai/v1",
        azureApiVersion: "v1",
      },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(readAssistantText(result)).toBe("partial azure summary");
  });

  it("returns an error for Codex Responses text without a terminal event", async () => {
    globalThis.fetch = vi.fn(async () =>
      prematureEventStream([
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          item_id: "message-partial",
          output_index: 0,
          content_index: 0,
          delta: "partial codex summary",
        },
      ]),
    ) as typeof fetch;

    const model: Model<"openai-codex-responses"> = {
      id: "gpt-test",
      name: "Codex test",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://codex.test/backend-api",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };
    const token = `e30.${btoa(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
      }),
    )}.sig`;

    const result = await streamOpenAICodexResponses(
      model,
      { messages: [] },
      { apiKey: token, transport: "sse" },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(readAssistantText(result)).toBe("partial codex summary");
  });
});
