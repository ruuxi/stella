import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { streamChat } from "./model-gateway";

// Helper: create a ReadableStream from SSE text
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

describe("streamChat", () => {
  const originalEnv = { ...import.meta.env };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    import.meta.env.VITE_CONVEX_URL = "https://test.convex.cloud";
    import.meta.env.VITE_CONVEX_HTTP_URL = "https://test.convex.site";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(import.meta.env, originalEnv);
  });

  const defaultPayload = {
    conversationId: "conv-1",
    userMessageId: "msg-1",
  };

  it("throws when VITE_CONVEX_URL is not set", async () => {
    import.meta.env.VITE_CONVEX_URL = "";
    await expect(streamChat(defaultPayload)).rejects.toThrow("VITE_CONVEX_URL is not set");
  });

  it("calls onAbort when signal is already aborted", async () => {
    const onAbort = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await streamChat(defaultPayload, { onAbort }, { signal: controller.signal });
    expect(onAbort).toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("handles HTTP error response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, { status: 500, statusText: "Internal Server Error" })
    );
    const onError = vi.fn();

    await expect(
      streamChat(defaultPayload, { onError })
    ).rejects.toThrow("Chat gateway error: 500");
    expect(onError).toHaveBeenCalled();
  });

  it("handles response with no body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, { status: 200 })
    );

    // Should not throw
    await streamChat(defaultPayload);
  });

  it("parses text-start, text-delta, and text-end events", async () => {
    const sseData = [
      'data: {"type":"text-start"}\n\n',
      'data: {"type":"text-delta","text":"Hello"}\n\n',
      'data: {"type":"text-delta","delta":" world"}\n\n',
      'data: {"type":"text-end"}\n\n',
    ].join("");

    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([sseData]), { status: 200 })
    );

    const onStart = vi.fn();
    const onTextDelta = vi.fn();
    const onDone = vi.fn();

    await streamChat(defaultPayload, { onStart, onTextDelta, onDone });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onTextDelta).toHaveBeenCalledWith("Hello");
    expect(onTextDelta).toHaveBeenCalledWith(" world");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("handles reasoning-delta events", async () => {
    const sseData = 'data: {"type":"reasoning-delta","text":"thinking..."}\n\n';
    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([sseData]), { status: 200 })
    );

    const onReasoningDelta = vi.fn();
    await streamChat(defaultPayload, { onReasoningDelta });
    expect(onReasoningDelta).toHaveBeenCalledWith("thinking...");
  });

  it("handles [DONE] sentinel", async () => {
    const sseData = 'data: [DONE]\n\n';
    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([sseData]), { status: 200 })
    );

    const onDone = vi.fn();
    await streamChat(defaultPayload, { onDone });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("does not call onDone twice for [DONE] followed by text-end", async () => {
    const sseData = [
      'data: [DONE]\n\n',
      'data: {"type":"text-end"}\n\n',
    ].join("");

    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([sseData]), { status: 200 })
    );

    const onDone = vi.fn();
    await streamChat(defaultPayload, { onDone });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("calls onDone when stream ends without explicit done event", async () => {
    const sseData = 'data: {"type":"text-delta","text":"partial"}\n\n';
    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([sseData]), { status: 200 })
    );

    const onDone = vi.fn();
    await streamChat(defaultPayload, { onDone });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("handles chunked SSE data split across reads", async () => {
    // Split a single event across two chunks
    const chunk1 = 'data: {"type":"text-del';
    const chunk2 = 'ta","text":"split"}\n\n';

    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([chunk1, chunk2]), { status: 200 })
    );

    const onTextDelta = vi.fn();
    await streamChat(defaultPayload, { onTextDelta });
    expect(onTextDelta).toHaveBeenCalledWith("split");
  });

  it("handles invalid JSON in data line via onError", async () => {
    const sseData = 'data: {invalid json}\n\n';
    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([sseData]), { status: 200 })
    );

    const onError = vi.fn();
    await streamChat(defaultPayload, { onError });
    expect(onError).toHaveBeenCalled();
  });

  it("skips lines that do not start with data:", async () => {
    const sseData = [
      ": comment\n",
      "event: custom\n",
      'data: {"type":"text-delta","text":"ok"}\n\n',
    ].join("");

    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([sseData]), { status: 200 })
    );

    const onTextDelta = vi.fn();
    await streamChat(defaultPayload, { onTextDelta });
    expect(onTextDelta).toHaveBeenCalledWith("ok");
  });

  it("skips empty data payloads", async () => {
    const sseData = 'data: \n\n';
    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([sseData]), { status: 200 })
    );

    const onTextDelta = vi.fn();
    const onDone = vi.fn();
    await streamChat(defaultPayload, { onTextDelta, onDone });
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it("handles fetch abort error", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    vi.mocked(fetch).mockRejectedValue(abortError);

    const onAbort = vi.fn();
    const controller = new AbortController();
    // Don't actually abort - just test AbortError name detection
    await streamChat(defaultPayload, { onAbort }, { signal: controller.signal });
    expect(onAbort).toHaveBeenCalled();
  });

  it("handles non-abort fetch error", async () => {
    const networkError = new Error("Network failure");
    vi.mocked(fetch).mockRejectedValue(networkError);

    const onError = vi.fn();
    await expect(streamChat(defaultPayload, { onError })).rejects.toThrow("Network failure");
    expect(onError).toHaveBeenCalledWith(networkError);
  });

  it("constructs correct endpoint URL", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));

    await streamChat(defaultPayload);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("/api/chat"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        }),
      })
    );
  });

  it("handles finish event type as done", async () => {
    const sseData = 'data: {"type":"finish"}\n\n';
    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([sseData]), { status: 200 })
    );

    const onDone = vi.fn();
    await streamChat(defaultPayload, { onDone });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("ignores empty text-delta values", async () => {
    const sseData = 'data: {"type":"text-delta","text":""}\n\n';
    vi.mocked(fetch).mockResolvedValue(
      new Response(sseStream([sseData]), { status: 200 })
    );

    const onTextDelta = vi.fn();
    await streamChat(defaultPayload, { onTextDelta });
    expect(onTextDelta).not.toHaveBeenCalled();
  });
});
