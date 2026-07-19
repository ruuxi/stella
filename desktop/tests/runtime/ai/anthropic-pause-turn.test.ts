import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { streamAnthropic } from "../../../../runtime/ai/providers/anthropic.js";
import { readAssistantText } from "../../../../runtime/ai/stream.js";
import type { Context, Model } from "../../../../runtime/ai/types.js";
import {
  isTransientProviderStreamAnomalyMessage,
  pausedTurnStopMessage,
} from "../../../../runtime/ai/utils/provider-stop.js";
import { classifyAgentRunFailure } from "../../../../runtime/kernel/agent-runtime/agent-run-retry.js";
import { isProviderContentAbortMessage } from "../../../../runtime/kernel/agent-runtime/provider-abort-containment.js";

const model: Model<"anthropic-messages"> = {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 128_000,
  contextWindow: 200_000,
};

const context: Context = {
  systemPrompt: "you are a test",
  messages: [{ role: "user", content: "hi", timestamp: 0 }],
  tools: [],
};

const sse = (events: Array<[string, unknown]>): string =>
  events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");

/**
 * Fake Anthropic SDK client that serves one pre-baked SSE body per
 * `messages.create` call (repeating the last body when exhausted) and
 * records every request payload for continuation assertions.
 */
function makeQueuedClient(bodies: string[]) {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> =
    [];
  let call = 0;
  const create = (body: unknown) => {
    requests.push(body as (typeof requests)[number]);
    const sseBody = bodies[Math.min(call, bodies.length - 1)]!;
    call += 1;
    return {
      asResponse: async () =>
        new Response(new TextEncoder().encode(sseBody), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    };
  };
  return {
    client: { messages: { create } } as unknown as Anthropic,
    requests,
  };
}

const messageStart = (id: string, inputTokens: number): [string, unknown] => [
  "message_start",
  {
    type: "message_start",
    message: {
      id,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  },
];

const textBlock = (text: string): Array<[string, unknown]> => [
  [
    "content_block_start",
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
];

const messageEnd = (
  stopReason: string,
  outputTokens: number,
): Array<[string, unknown]> => [
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: outputTokens },
    },
  ],
  ["message_stop", { type: "message_stop" }],
];

const pausedSegment = sse([
  messageStart("msg_paused", 10),
  ...textBlock("Hello "),
  ...messageEnd("pause_turn", 5),
]);

describe("anthropic pause_turn resubmission", () => {
  it("resubmits the paused content and completes the turn cleanly", async () => {
    const completedSegment = sse([
      messageStart("msg_done", 7),
      ...textBlock("world"),
      ...messageEnd("end_turn", 3),
    ]);
    const { client, requests } = makeQueuedClient([
      pausedSegment,
      completedSegment,
    ]);

    const result = await streamAnthropic(model, context, { client }).result();

    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(readAssistantText(result)).toBe("Hello world");
    // Usage accumulates across the pause boundary instead of resetting.
    expect(result.usage.input).toBe(17);
    expect(result.usage.output).toBe(8);

    expect(requests).toHaveLength(2);
    const continuation = requests[1]!.messages[requests[1]!.messages.length - 1]!;
    expect(continuation.role).toBe("assistant");
    expect(continuation.content).toEqual([{ type: "text", text: "Hello " }]);
  });

  it("surfaces a retryable pause error when the resubmit budget is exhausted", async () => {
    const { client, requests } = makeQueuedClient([pausedSegment]);

    const result = await streamAnthropic(model, context, { client }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('"pause_turn"');
    expect(result.errorMessage).toBe(pausedTurnStopMessage());
    // 1 initial request + MAX_PAUSE_TURN_RESUBMITS continuations.
    expect(requests).toHaveLength(5);

    const failure = classifyAgentRunFailure(new Error(result.errorMessage!));
    expect(failure.retryable).toBe(true);
    expect(failure.category).toBe("transport");
    expect(isProviderContentAbortMessage(result.errorMessage)).toBe(false);
  });

  it("does not resubmit when the paused turn streamed uncaptured block types", async () => {
    const serverToolSegment = sse([
      messageStart("msg_server_tool", 10),
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "server_tool_use", id: "st_1", name: "web_search" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ...messageEnd("pause_turn", 2),
    ]);
    const { client, requests } = makeQueuedClient([serverToolSegment]);

    const result = await streamAnthropic(model, context, { client }).result();

    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(pausedTurnStopMessage());
    expect(classifyAgentRunFailure(new Error(result.errorMessage!)).retryable).toBe(
      true,
    );
  });
});

describe("anthropic unknown stop reason policy", () => {
  it("maps unknown future stop reasons to a retryable anomalous stop, never a clean stop", async () => {
    const unknownSegment = sse([
      messageStart("msg_unknown", 4),
      ...textBlock("partial answer"),
      ...messageEnd("hyperstream_reset", 2),
    ]);
    const { client, requests } = makeQueuedClient([unknownSegment]);

    const result = await streamAnthropic(model, context, { client }).result();

    // Policy: unknown stop reason on a fully-streamed message degrades to an
    // "error" stop whose neutral wording the agent-run retry ladder treats as
    // a retryable transport failure — bounded retries, then the raw reason
    // surfaces loudly. It must never masquerade as a clean stop, and it must
    // never classify as a content abort.
    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('stop reason: "hyperstream_reset"');
    const failure = classifyAgentRunFailure(new Error(result.errorMessage!));
    expect(failure.retryable).toBe(true);
    expect(failure.category).toBe("transport");
    expect(isProviderContentAbortMessage(result.errorMessage)).toBe(false);
  });
});

describe("anthropic premature EOF", () => {
  it("fails the stream with a retryable transport error when it ends before message_stop", async () => {
    const truncated = sse([
      messageStart("msg_truncated", 6),
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial reply" },
        },
      ],
    ]);
    const { client } = makeQueuedClient([truncated]);

    const result = await streamAnthropic(model, context, { client }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("stream ended before message_stop");
    expect(readAssistantText(result)).toBe("partial reply");
    expect(isTransientProviderStreamAnomalyMessage(result.errorMessage)).toBe(true);
    const failure = classifyAgentRunFailure(new Error(result.errorMessage!));
    expect(failure.retryable).toBe(true);
    expect(failure.category).toBe("transport");
  });
});
