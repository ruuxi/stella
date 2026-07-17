import { describe, expect, it, vi } from "vitest";
import {
  createRunEventRecorder,
  subscribeRuntimeAgentEvents,
} from "../../../../../runtime/kernel/agent-runtime/run-events.js";
import type { AssistantMessage } from "../../../../../runtime/ai/types.js";
import type { AgentEvent } from "../../../../../runtime/kernel/agent-core/types.js";
import {
  buildPreambleToolBoundaryMessage,
  createExternalAssistantUpdateBuffer,
  persistExternalAssistantPreamble,
} from "../../../../../runtime/kernel/agent-runtime/external-engines.js";

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
  it("persists completed native preambles with durable run and attempt identity", () => {
    let listener: ((event: AgentEvent) => void) | undefined;
    const agent = {
      state: { messages: [] },
      subscribe: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next;
        return () => undefined;
      }),
    };
    const store = {
      recordRunEvent: vi.fn(),
      appendThreadMessage: vi.fn(),
    };
    const preambleWithTool: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "I’ll inspect the current runtime state." },
        { type: "toolCall", id: "call-read", name: "read", arguments: {} },
      ],
      api: "openai-completions",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 7,
    };

    subscribeRuntimeAgentEvents({
      agent,
      runId: "run-current-attempt",
      agentType: "general",
      recorder: createRunEventRecorder({
        store: store as never,
        runId: "run-current-attempt",
        conversationId: "conversation-1",
        agentType: "general",
        userMessageId: "user-1",
      }),
      threadStore: store as never,
      threadKey: "general:thread-1",
      conversationId: "conversation-1",
      attemptGeneration: 3,
    });

    listener?.({ type: "message_end", message: preambleWithTool });
    expect(store.appendThreadMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadKey: "general:thread-1",
        role: "assistant",
        payload: expect.objectContaining({
          stopReason: "toolUse",
          stellaRunId: "run-current-attempt",
          stellaAttemptGeneration: 3,
        }),
      }),
    );
  });

  it.each([
    ["codex", "openai-codex", "codex"],
    ["claude_code", "anthropic", "claude-code"],
  ] as const)(
    "persists one complete %s preamble without partial fragments",
    (engine, provider, model) => {
      const appendThreadMessage = vi.fn();
      persistExternalAssistantPreamble({
        store: { appendThreadMessage } as never,
        threadKey: "agent-1",
        preamble: "  I inspected the route.  ",
        engine,
        runId: "run-7",
        attemptGeneration: 7,
      });

      expect(appendThreadMessage).toHaveBeenCalledOnce();
      expect(appendThreadMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          threadKey: "agent-1",
          role: "assistant",
          content: "I inspected the route.",
          payload: expect.objectContaining({
            role: "assistant",
            provider,
            model,
            stopReason: "toolUse",
            stellaRunId: "run-7",
            stellaAttemptGeneration: 7,
            content: [{ type: "text", text: "I inspected the route." }],
          }),
        }),
      );
    },
  );

  it.each(["codex", "claude_code"] as const)(
    "persists only completed %s interim boundaries across final and interrupted turns",
    (engine) => {
      const appendThreadMessage = vi.fn();
      const createBuffer = () =>
        createExternalAssistantUpdateBuffer({
          store: { appendThreadMessage } as never,
          threadKey: "agent-1",
          engine,
          runId: "run-9",
          attemptGeneration: 9,
        });

      const completed = createBuffer();
      completed.append("I inspected ");
      completed.append("the route.");
      expect(appendThreadMessage).not.toHaveBeenCalled();
      expect(completed.flushBeforeTool()).toBe("I inspected the route.");
      completed.append("This is the final answer.");
      completed.discard();
      expect(completed.flushBeforeTool()).toBe("");

      const interrupted = createBuffer();
      interrupted.append("Partial text before interruption");
      interrupted.discard();
      expect(interrupted.flushBeforeTool()).toBe("");

      const resumed = createBuffer();
      resumed.append("I resumed and checked the build.");
      expect(resumed.flushBeforeTool()).toBe(
        "I resumed and checked the build.",
      );
      expect(appendThreadMessage).toHaveBeenCalledTimes(2);
    },
  );

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

  it("emits no boundary event for an empty preamble", () => {
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

  it("flags emitted interim events but not final answers", () => {
    const recorder = makeRecorder();
    const interim = recorder.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble: "Let me look that up.",
        toolCallId: "call-1",
        toolName: "web",
        toolArgs: {},
      }),
    );
    expect(interim?.followedByToolCall).toBe(true);
    expect(
      recorder.recordAssistantTextEnd("Tokyo has ~14 million.")
        ?.followedByToolCall,
    ).toBeUndefined();
  });
});
