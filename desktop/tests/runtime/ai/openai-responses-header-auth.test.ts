import { afterEach, describe, expect, it, vi } from "vitest";

import { streamSimpleOpenAIResponses } from "../../../../runtime/ai/providers/openai-responses.js";
import type { Model } from "../../../../runtime/ai/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("openai-responses header-only authentication", () => {
  it("uses a transport sentinel while preserving configured Authorization", async () => {
    let requestHeaders: Headers | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestHeaders = request.headers;
      return new Response(
        JSON.stringify({ error: { message: "intentional test stop" } }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const model: Model<"openai-responses"> = {
      id: "responses-model",
      name: "Responses model",
      api: "openai-responses",
      provider: "header-responses",
      baseUrl: "https://header-responses.test/v1",
      headers: { Authorization: "Bearer header-token" },
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };

    const result = await streamSimpleOpenAIResponses(model, {
      messages: [],
    }).result();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(requestHeaders?.get("authorization")).toBe("Bearer header-token");
    expect(result.errorMessage).not.toMatch(/No API key for provider/u);
  });

  it("uses the shared prompt-cache key without replacing transport affinity", async () => {
    let requestHeaders: Headers | undefined;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestHeaders = request.headers;
      requestBody = (await request.clone().json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ error: { message: "intentional test stop" } }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const model: Model<"openai-responses"> = {
      id: "responses-model",
      name: "Responses model",
      api: "openai-responses",
      provider: "fireworks",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };

    await streamSimpleOpenAIResponses(
      model,
      { messages: [] },
      {
        apiKey: "stella-token",
        sessionId: "agent-thread-1",
        promptCacheKey: "conversation-1",
      },
    ).result();

    expect(requestHeaders?.get("session_id")).toBe("agent-thread-1");
    expect(requestHeaders?.get("x-client-request-id")).toBe(
      "agent-thread-1",
    );
    expect(requestHeaders?.get("x-session-affinity")).toBe("conversation-1");
    expect(requestBody?.prompt_cache_key).toBe("conversation-1");
    expect(requestBody?.store).toBe(true);
  });
});
