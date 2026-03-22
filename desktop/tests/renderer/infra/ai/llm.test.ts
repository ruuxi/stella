import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateServiceRequest = vi.fn();

vi.mock("@/infra/http/service-request", () => ({
  createServiceRequest: (...args: unknown[]) => mockCreateServiceRequest(...args),
}));

const encodeStream = (lines: string[]) => {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= lines.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(lines[index]));
      index += 1;
    },
  });
};

describe("streamChatCompletion", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateServiceRequest.mockResolvedValue({
      endpoint: "https://example.test/api/stella/v1/chat/completions",
      headers: {
        Authorization: "Bearer test-token",
      },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("falls back to the terminal assistant message when the stream emits no text deltas", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        encodeStream([
          'data: {"choices":[{"message":{"content":"Final assistant reply"}}]}\n',
          "\n",
          "data: [DONE]\n",
          "\n",
        ]),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        },
      ),
    ) as typeof fetch;

    const { streamChatCompletion } = await import(
      "../../../../src/infra/ai/llm"
    );

    const onChunk = vi.fn();
    await expect(
      streamChatCompletion({
        agentType: "general",
        messages: [{ role: "user", content: "hello" }],
        onChunk,
      }),
    ).resolves.toBe("Final assistant reply");

    expect(onChunk).not.toHaveBeenCalled();
  });
});
