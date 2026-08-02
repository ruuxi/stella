import { describe, expect, it } from "vitest";

import { transformMessages } from "../../../../runtime/ai/providers/transform-messages.js";
import type { Message, Model } from "../../../../runtime/ai/types.js";
import { PI_AGENT_MESSAGE_FILTER } from "../../../../runtime/kernel/agent-runtime/shared.js";

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
  it("silently removes images for text-only models while keeping their descriptions", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is wrong here?" },
          {
            type: "image",
            mimeType: "image/png",
            data: "AAAA",
            sourcePath: "/tmp/current-image.png",
          },
          {
            type: "text",
            text: "<image_description>\nA red error dialog.\n</image_description>",
          },
        ],
        timestamp: 1,
      },
    ];

    const result = transformMessages(messages, anthropicModel);

    expect(result).toEqual([
      {
        ...messages[0],
        content: [
          { type: "text", text: "What is wrong here?" },
          {
            type: "text",
            text:
              "<image_reference>\n/tmp/current-image.png\nUse the Read tool with file_path set to this absolute path to inspect the image.\n</image_reference>",
          },
          {
            type: "text",
            text: "<image_description>\nA red error dialog.\n</image_description>",
          },
        ],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("image omitted");
  });

  it("keeps a minimal legacy placeholder when an old image has no durable path", () => {
    const result = transformMessages(
      [
        {
          role: "user",
          content: [
            { type: "image", mimeType: "image/png", data: "AAAA" },
          ],
          timestamp: 1,
        },
      ],
      anthropicModel,
    );

    expect(result).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "(image omitted)",
          },
        ],
        timestamp: 1,
      },
    ]);
  });

  it("replaces a historical image with a Read reference when a path was persisted", () => {
    const result = transformMessages(
      [
        {
          role: "user",
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: "AAAA",
              sourcePath: "/tmp/older-image.png",
            },
          ],
          timestamp: 1,
        },
      ],
      anthropicModel,
    );

    expect(result).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "<image_reference>\n/tmp/older-image.png\nUse the Read tool with file_path set to this absolute path to inspect the image.\n</image_reference>",
          },
        ],
        timestamp: 1,
      },
    ]);
  });

  it("pairs a persisted description with its image before removing the current image", () => {
    const llmMessages = PI_AGENT_MESSAGE_FILTER([
      {
        role: "user",
        content: [
          { type: "text", text: "What is wrong here?" },
          {
            type: "image",
            mimeType: "image/png",
            data: "AAAA",
            sourcePath: "/tmp/paired-image.png",
          },
        ],
        timestamp: 1,
      },
      {
        role: "runtimeInternal",
        customType: "vision.image_description",
        display: false,
        content: [
          {
            type: "text",
            text: "<image_description>\nA red error dialog.\n</image_description>",
          },
        ],
        timestamp: 2,
      },
    ]);

    expect(transformMessages(llmMessages, anthropicModel)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is wrong here?" },
          {
            type: "text",
            text:
              "<image_reference>\n/tmp/paired-image.png\nUse the Read tool with file_path set to this absolute path to inspect the image.\n</image_reference>",
          },
          {
            type: "text",
            text: "<image_description>\nA red error dialog.\n</image_description>",
          },
        ],
        timestamp: 1,
      },
    ]);
  });

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

  it("drops a tool result whose only tool call was on an errored assistant turn", () => {
    // Repro for the Anthropic 400 "tool_result ... must have a corresponding
    // tool_use block in the previous message": an aborted/errored assistant
    // turn is stripped, so its tool result must be dropped as an orphan rather
    // than emitted on its own.
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Run the tool." }],
        timestamp: 1,
      },
      {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-opus-4.7",
        usage,
        stopReason: "error",
        timestamp: 2,
        content: [
          {
            type: "toolCall",
            id: "toolu_orphan",
            name: "Bash",
            arguments: { command: "ls" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "toolu_orphan",
        toolName: "Bash",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Try again." }],
        timestamp: 4,
      },
    ];

    const result = transformMessages(messages, anthropicModel);

    expect(
      result.some(
        (msg) =>
          msg.role === "toolResult" && msg.toolCallId === "toolu_orphan",
      ),
    ).toBe(false);
    expect(result.some((msg) => msg.role === "assistant")).toBe(false);
    expect(result.map((msg) => msg.role)).toEqual(["user", "user"]);
  });

  it("re-anchors tool results next to their call when a reminder is interleaved", () => {
    // Repro for the live Anthropic 400: a runtime.task_lifecycle reminder
    // (rebuilt as a user message) is persisted between the assistant tool_use
    // and its results, so history replay yields tool_use -> user -> results.
    // The fix must move the real results back adjacent to the call (in call
    // order) and not duplicate or synthesize them.
    const messages: Message[] = [
      {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-opus-4.8",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
        content: [
          { type: "text", text: "scheduling + spawning" },
          { type: "toolCall", id: "toolu_sched", name: "Schedule", arguments: {} },
          { type: "toolCall", id: "toolu_spawn", name: "spawn_agent", arguments: {} },
        ],
      },
      // Reminder injected between the tool_use and its results.
      {
        role: "user",
        content: [{ type: "text", text: "<system_reminder> The agent has finished." }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_sched",
        toolName: "Schedule",
        content: [{ type: "text", text: "scheduled" }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_spawn",
        toolName: "spawn_agent",
        content: [{ type: "text", text: "{\"thread_id\":\"b\"}" }],
        isError: false,
        timestamp: 4,
      },
      {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-opus-4.8",
        usage,
        stopReason: "stop",
        timestamp: 5,
        content: [{ type: "text", text: "done" }],
      },
    ];

    const result = transformMessages(messages, anthropicModel);

    expect(result.map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "toolResult",
      "user",
      "assistant",
    ]);
    // Results sit immediately after the tool_use turn, in call order, with the
    // real content (not a synthetic "No result provided") and no duplicates.
    const first = result[1] as Extract<Message, { role: "toolResult" }>;
    const second = result[2] as Extract<Message, { role: "toolResult" }>;
    expect(first.toolCallId).toBe("toolu_sched");
    expect(first.isError).toBe(false);
    expect(second.toolCallId).toBe("toolu_spawn");
    expect(second.isError).toBe(false);
    expect(
      result.filter(
        (m) => m.role === "toolResult" && m.toolCallId === "toolu_sched",
      ).length,
    ).toBe(1);
  });

  it("keeps a tool result paired with a successful assistant tool call", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-opus-4.7",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
        content: [
          {
            type: "toolCall",
            id: "toolu_ok",
            name: "Bash",
            arguments: { command: "ls" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "toolu_ok",
        toolName: "Bash",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 2,
      },
    ];

    const result = transformMessages(messages, anthropicModel);

    expect(
      result.some(
        (msg) => msg.role === "toolResult" && msg.toolCallId === "toolu_ok",
      ),
    ).toBe(true);
  });
});
