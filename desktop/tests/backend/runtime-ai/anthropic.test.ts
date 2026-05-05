import { describe, expect, it } from "bun:test";

import { convertMessages } from "../../../../backend/convex/runtime_ai/anthropic";
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
});
