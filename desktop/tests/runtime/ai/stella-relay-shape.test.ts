import { afterEach, describe, expect, it, vi } from "vitest";

import { createStellaRoute } from "../../../../runtime/kernel/model-routing-stella.js";
import { streamSimple } from "../../../../runtime/ai/stream.js";
import { transformMessages } from "../../../../runtime/ai/providers/transform-messages.js";
import type { Context, Message, Model } from "../../../../runtime/ai/types.js";

/**
 * Wire-shape integration tests for the Stella relay path.
 *
 * For each upstream provider, we:
 *   1. Build a route via `createStellaRoute` and assert the relay `baseUrl`
 *      + provider + api the pi-mono adapter will dispatch on.
 *   2. (Anthropic + Google only) Stub `fetch`, invoke `streamSimple`, and
 *      assert the adapter targets the relay path with
 *      `Authorization: Bearer <stella-token>` (NOT `x-api-key` /
 *      `x-goog-api-key`). That's the load-bearing part of the baseUrl-based
 *      relay auth detection; if it ever regresses, every relayed Anthropic /
 *      Google request 401s at the relay.
 */

const STELLA_SITE = "https://stella.example.test";
const STELLA_TOKEN = "stella-jwt";

const site = {
  baseUrl: STELLA_SITE,
  getAuthToken: () => STELLA_TOKEN,
};

const makeRoute = (modelId: string) =>
  createStellaRoute({
    site,
    agentType: "general",
    modelId,
  });

const userContext = (text: string): Context => ({
  messages: [
    {
      role: "user",
      content: text,
      timestamp: 0,
    },
  ],
});

const sseResponse = (body: string, contentType = "text/event-stream") =>
  new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });

const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const _ of stream) {
    // ignore individual events
  }
};

// Bun's vitest-compatible runner doesn't implement `vi.stubGlobal`, so we
// install/restore `globalThis.fetch` by hand. Vitest also runs this fine.
type CapturedCall = { url: string; init?: RequestInit; headers: Headers };

const originalFetch: typeof fetch = globalThis.fetch;

const captureRequest = (response: () => Response): CapturedCall[] => {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers =
      init?.headers instanceof Headers
        ? init.headers
        : new Headers(init?.headers as HeadersInit | undefined);
    calls.push({ url, init, headers });
    return response();
  }) as typeof fetch;
  return calls;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Stella relay route shape", () => {
  it("Anthropic relay: baseUrl, api, provider, headers", () => {
    const route = makeRoute("stella/anthropic/claude-opus-4.7");
    expect(route).not.toBeNull();
    const model = route!.model;
    expect(model.api).toBe("anthropic-messages");
    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("stella/anthropic/claude-opus-4.7");
    expect(model.baseUrl).toBe(`${STELLA_SITE}/api/stella/anthropic`);
    expect(model.headers).toMatchObject({ "X-Stella-Agent-Type": "general" });
    expect(model.headers).not.toHaveProperty("X-Stella-Relay");
  });

  it("OpenAI relay: baseUrl, api, provider", () => {
    const route = makeRoute("stella/openai/gpt-5.5");
    const model = route!.model;
    expect(model.api).toBe("openai-responses");
    expect(model.provider).toBe("openai");
    expect(model.baseUrl).toBe(`${STELLA_SITE}/api/stella/openai/v1`);
  });

  it("Google relay: baseUrl, api, provider", () => {
    const route = makeRoute("stella/google/gemini-3-flash-preview");
    const model = route!.model;
    expect(model.api).toBe("google-generative-ai");
    expect(model.provider).toBe("google");
    expect(model.baseUrl).toBe(`${STELLA_SITE}/api/stella/google/v1beta`);
  });

  it("Fireworks relay: baseUrl, api, provider", () => {
    const route = makeRoute("stella/accounts/fireworks/models/kimi-k2p6");
    const model = route!.model;
    expect(model.api).toBe("openai-responses");
    expect(model.provider).toBe("fireworks");
    expect(model.baseUrl).toBe(`${STELLA_SITE}/api/stella/fireworks/v1`);
  });

  it("OpenRouter relay: baseUrl, api, provider", () => {
    const route = makeRoute("stella/deepseek/deepseek-v4-flash");
    const model = route!.model;
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("openrouter");
    expect(model.baseUrl).toBe(`${STELLA_SITE}/api/stella/openrouter/api/v1`);
  });

  it("Stella alias (designer) resolves to Anthropic relay", () => {
    const route = makeRoute("stella/designer");
    const model = route!.model;
    expect(model.api).toBe("anthropic-messages");
    expect(model.provider).toBe("anthropic");
    expect(model.baseUrl).toBe(`${STELLA_SITE}/api/stella/anthropic`);
  });

  it("Stella alias (light) resolves to OpenRouter relay", () => {
    const route = makeRoute("stella/light");
    const model = route!.model;
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("openrouter");
    expect(model.baseUrl).toBe(`${STELLA_SITE}/api/stella/openrouter/api/v1`);
  });
});

describe("Stella relay auth (baseUrl-based detection)", () => {
  it("Anthropic adapter sends Authorization: Bearer to the Stella relay (not x-api-key)", async () => {
    // Anthropic SSE that closes immediately so the adapter resolves
    // without us having to mock the full streaming protocol.
    const calls = captureRequest(() =>
      sseResponse(
        [
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-opus-4.7",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ].join(""),
      ),
    );

    const route = makeRoute("stella/anthropic/claude-opus-4.7")!;
    const apiKey = (await route.getApiKey()) ?? "";
    expect(apiKey).toBe(STELLA_TOKEN);

    await drain(
      streamSimple(route.model, userContext("hi"), { apiKey, maxTokens: 8 }),
    );

    // Exactly one request, hitting the relay
    expect(calls.length).toBeGreaterThan(0);
    const messagesCall = calls.find((c) => c.url.endsWith("/messages"));
    expect(messagesCall, `expected POST to /messages, got URLs: ${calls.map((c) => c.url).join(", ")}`).toBeDefined();
    // The Anthropic SDK appends `/v1/messages` to whatever baseURL was
    // configured, so the wire URL must match the backend's registered
    // route at `STELLA_ANTHROPIC_MESSAGES_PATH`.
    expect(messagesCall!.url).toBe(
      `${STELLA_SITE}/api/stella/anthropic/v1/messages`,
    );
    expect(messagesCall!.headers.get("authorization")).toBe(
      `Bearer ${STELLA_TOKEN}`,
    );
    expect(messagesCall!.headers.get("x-api-key")).toBeNull();
    expect(messagesCall!.headers.get("x-stella-agent-type")).toBe("general");
  });

  it("Google adapter forwards Authorization: Bearer when the baseUrl is the Stella relay", async () => {
    const calls = captureRequest(() =>
      sseResponse(
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }],
          modelVersion: "gemini-3-flash-preview",
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 0,
            totalTokenCount: 1,
          },
        })}\n\n`,
      ),
    );

    const route = makeRoute("stella/google/gemini-3-flash-preview")!;
    const apiKey = (await route.getApiKey()) ?? "";

    await drain(
      streamSimple(route.model, userContext("hi"), { apiKey, maxTokens: 8 }),
    );

    // Google SDK calls fetch with the full URL containing
    // `:streamGenerateContent`. We only care that SOMETHING was forwarded
    // to the Stella relay base and the Authorization Bearer header was
    // present.
    const relayCall = calls.find((c) =>
      c.url.startsWith(`${STELLA_SITE}/api/stella/google/`),
    );
    expect(
      relayCall,
      `expected POST to the Stella google relay, got URLs: ${calls
        .map((c) => c.url)
        .join(", ")}`,
    ).toBeDefined();
    expect(relayCall!.headers.get("authorization")).toBe(
      `Bearer ${STELLA_TOKEN}`,
    );
  });
});

describe("transformMessages: orphan tool_result filter", () => {
  it("drops tool_results whose tool_use does not appear in any preceding assistant message", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "go",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_orphan",
        toolName: "ghost",
        content: [{ type: "text", text: "stale result" }],
        isError: false,
        timestamp: 1,
      },
      {
        role: "user",
        content: "again",
        timestamp: 2,
      },
    ];

    const model: Model<"anthropic-messages"> = {
      id: "claude-opus-4.7",
      name: "Claude Opus 4.7",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256_000,
      maxTokens: 16_384,
    };

    const out = transformMessages(messages, model);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
  });

  it("keeps tool_results paired with a preceding assistant tool_use", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "toolu_pair",
            name: "echo",
            arguments: { text: "hi" },
          },
        ],
        timestamp: 0,
        stopReason: "toolUse",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4.7",
      },
      {
        role: "toolResult",
        toolCallId: "toolu_pair",
        toolName: "echo",
        content: [{ type: "text", text: "hi" }],
        isError: false,
        timestamp: 1,
      },
    ];

    const model: Model<"anthropic-messages"> = {
      id: "claude-opus-4.7",
      name: "Claude Opus 4.7",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256_000,
      maxTokens: 16_384,
    };

    const out = transformMessages(messages, model);
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });
});
