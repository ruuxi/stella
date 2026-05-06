import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../../../runtime/kernel/agent-core/types.js";
import {
  createRunEventRecorder,
  subscribeRuntimeAgentEvents,
} from "../../../../../runtime/kernel/agent-runtime/run-events.js";

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

const assistantMessage = {
  role: "assistant" as const,
  content: [
    {
      type: "thinking" as const,
      thinking: "Need to inspect the task.",
      thinkingSignature: '{"type":"reasoning","id":"rs_123"}',
    },
    { type: "text" as const, text: "" },
  ],
  api: "openai-responses" as const,
  provider: "openai",
  model: "gpt-5.4",
  usage,
  stopReason: "stop" as const,
  timestamp: 1,
};

describe("subscribeRuntimeAgentEvents", () => {
  it("does not surface provider thinking summaries as chat reasoning", () => {
    let listener: ((event: AgentEvent) => void) | undefined;
    const agent = {
      state: { messages: [] },
      subscribe: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next;
        return () => undefined;
      }),
    };
    const store = { recordRunEvent: vi.fn() };
    const onReasoning = vi.fn();
    const onStream = vi.fn();

    subscribeRuntimeAgentEvents({
      agent,
      runId: "run-1",
      agentType: "general",
      recorder: createRunEventRecorder({
        store: store as never,
        runId: "run-1",
        conversationId: "conversation-1",
        agentType: "general",
        userMessageId: "user-1",
      }),
      callbacks: {
        onReasoning,
        onStream,
      },
    });

    listener?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Need to inspect the task.",
        partial: assistantMessage,
      },
    });
    listener?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Need to inspect the task.",
        partial: assistantMessage,
      },
    });
    listener?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Done.",
        partial: {
          ...assistantMessage,
          content: [
            assistantMessage.content[0],
            { type: "text" as const, text: "Done." },
          ],
        },
      },
    });

    expect(onReasoning).not.toHaveBeenCalled();
    expect(onStream).toHaveBeenCalledWith(
      expect.objectContaining({ chunk: "Done." }),
    );
  });
});
