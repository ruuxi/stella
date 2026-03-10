import { describe, expect, it, vi } from "vitest";

const { completeSimpleMock, streamSimpleMock } = vi.hoisted(() => ({
  completeSimpleMock: vi.fn(),
  streamSimpleMock: vi.fn(),
}));

vi.mock("@stella/stella-ai", () => ({
  completeSimple: completeSimpleMock,
  streamSimple: streamSimpleMock,
}));

const { callManagedChatCompletion } = await import("../../../packages/stella-runtime/src/chat-completions.js");

describe("managed chat transport", () => {
  it("normalizes a full chat completions endpoint to the API base URL before creating the OpenAI client", async () => {
    completeSimpleMock.mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-completions",
      provider: "stella-managed",
      model: "default",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    await callManagedChatCompletion({
      transport: {
        endpoint: "https://demo.convex.site/api/managed-ai/chat/completions",
        headers: {
          Authorization: "Bearer token-123",
        },
      },
      request: {
        agentType: "orchestrator",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(completeSimpleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://demo.convex.site/api/managed-ai",
      }),
      expect.anything(),
      expect.anything(),
    );
  });
});
