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

const sseSuccessResponse = () =>
  new Response(
    [
      'data: {"type":"start"}\n',
      'data: {"type":"text_start","contentIndex":0}\n',
      'data: {"type":"text_delta","contentIndex":0,"delta":"ok"}\n',
      'data: {"type":"text_end","contentIndex":0}\n',
      'data: {"type":"done","reason":"stop","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}\n',
    ].join(""),
    { status: 200 },
  );

const errorResponse = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("streamStella connection retry", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries transient 5xx responses and succeeds without surfacing an error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(503, "Your request couldn't be completed. Try again later."),
      )
      .mockResolvedValueOnce(sseSuccessResponse());
    globalThis.fetch = fetchMock as typeof fetch;

    const events: Array<{ type: string }> = [];
    const consume = (async () => {
      for await (const event of streamStella(model, context, { apiKey: "token" })) {
        events.push(event);
      }
    })();

    // Drain microtasks → first 503 returned, retry scheduled (1s base delay).
    await vi.runAllTimersAsync();
    await consume;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("does not retry 4xx auth failures via the backoff path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(403, "Forbidden"));
    globalThis.fetch = fetchMock as typeof fetch;

    const events: Array<{ type: string }> = [];
    for await (const event of streamStella(model, context, { apiKey: "token" })) {
      events.push(event);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "error")).toBe(true);
  });
});
