import { describe, expect, it } from "vitest";

import { transformMessages } from "../../../../runtime/ai/providers/transform-messages.js";
import type { Message, Model } from "../../../../runtime/ai/types.js";

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

describe("runtime transformMessages", () => {
  it("drops cross-model thinking instead of replaying it as text", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        provider: "openrouter",
        api: "openai-responses",
        model: "openai/gpt-5.4",
        usage,
        stopReason: "stop",
        timestamp: 1,
        content: [
          {
            type: "thinking",
            thinking:
              "The user is asking a health question. I should answer carefully.",
          },
          {
            type: "text",
            text: "Final answer.",
          },
        ],
      },
    ];

    expect(transformMessages(messages, anthropicModel)[0]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Final answer.",
        },
      ],
    });
  });
});
