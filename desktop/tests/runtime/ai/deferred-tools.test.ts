import { describe, expect, it } from "vitest";

import type {
  Context,
  Model,
  Tool,
} from "../../../../runtime/ai/types.js";
import { splitDeferredTools } from "../../../../runtime/ai/utils/deferred-tools.js";
import {
  convertResponsesMessages,
  convertResponsesTools,
} from "../../../../runtime/ai/providers/openai-responses-shared.js";
import {
  convertMessages as convertAnthropicMessages,
  convertTools as convertAnthropicTools,
} from "../../../../runtime/ai/providers/anthropic.js";
import {
  convertMessages as convertCompletionMessages,
  getCompat as getCompletionCompat,
} from "../../../../runtime/ai/providers/openai-completions.js";

const searchTool: Tool = {
  name: "tool_search",
  description: "Find tools",
  parameters: { type: "object" } as Tool["parameters"],
};
const calendarTool: Tool = {
  name: "calendar_list",
  description: "List calendar events",
  parameters: { type: "object" } as Tool["parameters"],
};

const context = (): Context => ({
  messages: [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-search",
          name: "tool_search",
          arguments: { query: "calendar" },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
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
      },
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "call-search",
      toolName: "tool_search",
      content: [{ type: "text", text: "Calendar tool loaded." }],
      addedToolNames: ["calendar_list"],
      isError: false,
      timestamp: 2,
    },
  ],
  tools: [searchTool, calendarTool],
});

const openAIModel = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128_000,
  maxTokens: 32_000,
} satisfies Model<"openai-responses">;

describe("deferred tool load points", () => {
  it("splits activated but unused tools from the stable top-level list", () => {
    const placement = splitDeferredTools(context(), true);

    expect(placement.immediate.map((tool) => tool.name)).toEqual([
      "tool_search",
    ]);
    expect([...placement.deferred]).toEqual([
      ["calendar_list", calendarTool],
    ]);
  });

  it("projects OpenAI client tool-search items at the discovery result", () => {
    const source = context();
    const placement = splitDeferredTools(source, true);
    const input = convertResponsesMessages(
      openAIModel,
      source,
      new Set(["openai"]),
      { deferredTools: placement.deferred },
    ) as Array<Record<string, unknown>>;

    expect(input.map((item) => item.type).filter(Boolean)).toContain(
      "tool_search_call",
    );
    expect(input.map((item) => item.type).filter(Boolean)).toContain(
      "tool_search_output",
    );
    const output = input.find((item) => item.type === "tool_search_output") as {
      tools?: Array<Record<string, unknown>>;
    };
    expect(output.tools?.[0]).toMatchObject({
      name: "calendar_list",
      defer_loading: true,
    });
    expect(convertResponsesTools(placement.immediate).map((tool) => tool.name))
      .toEqual(["tool_search"]);
  });

  it("projects Anthropic tool references without mixing result text", () => {
    const anthropicModel = {
      ...openAIModel,
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-4-5",
    } satisfies Model<"anthropic-messages">;
    const messages = convertAnthropicMessages(
      context().messages,
      anthropicModel,
      false,
      undefined,
      new Set(["calendar_list"]),
    );
    const user = messages.at(-1);

    expect(user?.role).toBe("user");
    expect(user?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call-search",
        content: [
          {
            type: "tool_reference",
            tool_name: "calendar_list",
          },
        ],
        is_error: false,
      },
      { type: "text", text: "Calendar tool loaded." },
    ]);
    expect(
      convertAnthropicTools([calendarTool], false, true, undefined, true)[0],
    ).toMatchObject({
      name: "calendar_list",
      defer_loading: true,
    });
  });

  it("projects Kimi loaded tools as a transcript system tool message", () => {
    const kimiModel = {
      ...openAIModel,
      api: "openai-completions",
      provider: "moonshotai",
      id: "kimi-k2.5",
      compat: { deferredToolsMode: "kimi" },
    } satisfies Model<"openai-completions">;
    const messages = convertCompletionMessages(
      kimiModel,
      context(),
      getCompletionCompat(kimiModel),
    ) as Array<Record<string, unknown>>;

    expect(messages.at(-1)).toMatchObject({
      role: "system",
      tools: [
        {
          function: {
            name: "calendar_list",
          },
        },
      ],
    });
  });
});
