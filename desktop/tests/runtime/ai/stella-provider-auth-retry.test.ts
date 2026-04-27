import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../../../../runtime/ai/types.js";
import { streamStella } from "../../../../runtime/ai/providers/stella.js";

const model: Model<"stella"> = {
  id: "stella/openai/gpt-5.1-codex",
  name: "Stella Recommended",
  api: "stella",
  provider: "stella",
  baseUrl: "https://stella.example.test",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const context: Context = {
  systemPrompt: "You are Stella.",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
};

const sseResponse = () =>
  new Response(
    [
      "data: {\"type\":\"start\"}\n",
      "data: {\"type\":\"text_start\",\"contentIndex\":0}\n",
      "data: {\"type\":\"text_delta\",\"contentIndex\":0,\"delta\":\"ok\"}\n",
      "data: {\"type\":\"text_end\",\"contentIndex\":0}\n",
      "data: {\"type\":\"done\",\"reason\":\"stop\",\"usage\":{\"input\":1,\"output\":1,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":2,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}}}\n",
    ].join(""),
    { status: 200 },
  );

describe("streamStella auth retry", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("refreshes the API key and retries once after an auth failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Token expired 7 seconds ago", { status: 401 }))
      .mockResolvedValueOnce(sseResponse());
    globalThis.fetch = fetchMock as typeof fetch;

    const events = [];
    for await (const event of streamStella(model, context, {
      apiKey: "old-token",
      refreshApiKey: async () => "new-token",
    })) {
      events.push(event);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers.Authorization).toBe("Bearer old-token");
    expect(fetchMock.mock.calls[1]?.[1]?.headers.Authorization).toBe("Bearer new-token");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });
});
