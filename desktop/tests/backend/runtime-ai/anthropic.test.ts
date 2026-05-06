import { describe, expect, it } from "bun:test";

import { convertMessages, streamAnthropic } from "../../../../backend/convex/runtime_ai/anthropic";
import type { AssistantMessageEvent } from "../../../../backend/convex/runtime_ai/types";
import type {
  Context,
  Model,
} from "../../../../backend/convex/runtime_ai/types";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const anthropicModel: Model<"anthropic-messages"> = {
  id: "claude-opus-4.7",
  name: "Claude Opus 4.7",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  maxTokens: 128_000,
  contextWindow: 200_000,
};

describe("backend Anthropic message conversion", () => {
  it("normalizes cross-provider tool_use ids and matching tool_result ids", () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.5",
          usage,
          stopReason: "toolUse",
          timestamp: 1,
          content: [
            {
              type: "toolCall",
              id: "call_abc|fc_response.item.bad",
              name: "multi_tool_use_parallel",
              arguments: { tool_uses: [] },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_abc|fc_response.item.bad",
          toolName: "multi_tool_use_parallel",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const messages = convertMessages(anthropicModel, context);
    const assistant = messages[0];
    const result = messages[1];

    expect(assistant?.role).toBe("assistant");
    expect(result?.role).toBe("user");

    const toolUse =
      assistant?.role === "assistant" && Array.isArray(assistant.content)
        ? assistant.content[0]
        : null;
    const toolResult =
      result?.role === "user" && Array.isArray(result.content)
        ? result.content[0]
        : null;

    expect(toolUse).toMatchObject({
      type: "tool_use",
      id: "call_abc_fc_response_item_bad",
      name: "multi_tool_use_parallel",
    });
    expect(toolResult).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_abc_fc_response_item_bad",
    });
  });

  it("replays signed and redacted thinking as Anthropic thinking blocks", () => {
    const context: Context = {
      messages: [
        {
          role: "assistant",
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-opus-4.7",
          usage,
          stopReason: "stop",
          timestamp: 1,
          content: [
            {
              type: "thinking",
              thinking: "Reasoning summary.",
              thinkingSignature: "sig_123",
            },
            {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: "opaque_payload",
              redacted: true,
            },
            {
              type: "text",
              text: "Final answer.",
            },
          ],
        },
      ],
    };

    const messages = convertMessages(anthropicModel, context);
    const assistant = messages[0];
    const content =
      assistant?.role === "assistant" && Array.isArray(assistant.content)
        ? assistant.content
        : [];

    expect(content).toEqual([
      {
        type: "thinking",
        thinking: "Reasoning summary.",
        signature: "sig_123",
      },
      {
        type: "redacted_thinking",
        data: "opaque_payload",
      },
      {
        type: "text",
        text: "Final answer.",
      },
    ]);
  });

  it("captures Anthropic thinking signatures while streaming", async () => {
    const priorFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const sse = [
      { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reasoning." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "123" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Final." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");

    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sse));
            controller.close();
          },
        }),
        { status: 200 },
      );

    try {
      const stream = streamAnthropic(anthropicModel, { messages: [] }, { apiKey: "test-key" });
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      const done = events.find((event) => event.type === "done");
      expect(done?.type).toBe("done");
      if (done?.type !== "done") {
        throw new Error("Expected done event");
      }
      expect(done.message.content).toEqual([
        {
          type: "thinking",
          thinking: "Reasoning.",
          thinkingSignature: "sig_123",
        },
        {
          type: "text",
          text: "Final.",
        },
      ]);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
