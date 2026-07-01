import { describe, expect, it, vi } from "vitest";

import { createRunEventRecorder } from "../../../../../runtime/kernel/agent-runtime/run-events.js";
import { buildPreambleToolBoundaryMessage } from "../../../../../runtime/kernel/agent-runtime/external-engines.js";

const makeRecorder = () => {
  const store = { recordRunEvent: vi.fn() };
  return createRunEventRecorder({
    store: store as never,
    runId: "run-codex",
    conversationId: "conversation-1",
    agentType: "orchestrator",
    userMessageId: "user-1",
    getResponseTarget: () => ({ type: "user_turn" }),
  });
};

describe("external-engine preamble→tool boundary", () => {
  it("pairs streamed preamble text with the tool call it precedes", () => {
    const message = buildPreambleToolBoundaryMessage({
      preamble: "Let me look that up.",
      toolCallId: "call-1",
      toolName: "web",
      toolArgs: { query: "tokyo population" },
    });
    expect(message.role).toBe("assistant");
    const blocks = Array.isArray(message.content) ? message.content : [];
    expect(blocks.map((block) => block.type)).toEqual(["text", "toolCall"]);
    const toolCall = blocks.find((block) => block.type === "toolCall");
    expect(toolCall).toMatchObject({ id: "call-1", name: "web" });
  });

  it("flags the emitted assistant-message event as followedByToolCall", () => {
    const recorder = makeRecorder();
    const event = recorder.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble: "Let me look that up.",
        toolCallId: "call-1",
        toolName: "web",
        toolArgs: {},
      }),
    );
    expect(event?.text).toBe("Let me look that up.");
    expect(event?.followedByToolCall).toBe(true);
  });

  it("emits no boundary event for an empty preamble (tool-only step)", () => {
    const recorder = makeRecorder();
    const event = recorder.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble: "   ",
        toolCallId: "call-1",
        toolName: "web",
        toolArgs: {},
      }),
    );
    expect(event).toBeNull();
  });

  it("does not flag a plain final answer as followedByToolCall", () => {
    const recorder = makeRecorder();
    const finalEvent = recorder.recordAssistantTextEnd("Tokyo has ~14 million.");
    expect(finalEvent?.text).toBe("Tokyo has ~14 million.");
    expect(finalEvent?.followedByToolCall).toBeUndefined();
  });
});
