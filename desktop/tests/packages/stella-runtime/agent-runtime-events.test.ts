import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentMessage } from "../../../electron/core/agent/types.js";
import {
  createRunEventRecorder,
  subscribeRuntimeAgentEvents,
} from "../../../electron/core/runtime/agent-runtime/run-events.js";

const createFakeAgent = (messages: AgentMessage[] = []) => {
  let listener: ((event: AgentEvent) => void) | null = null;

  return {
    state: {
      messages,
    },
    subscribe(fn: (event: AgentEvent) => void) {
      listener = fn;
      return () => {
        if (listener === fn) {
          listener = null;
        }
      };
    },
    emit(event: AgentEvent) {
      listener?.(event);
    },
  };
};

describe("agent runtime event helpers", () => {
  it("records stream and tool lifecycle events through the shared recorder", () => {
    const store = {
      recordRunEvent: vi.fn(),
    };
    const callbacks = {
      onStream: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
    };
    const onProgress = vi.fn();
    const agent = createFakeAgent();
    const recorder = createRunEventRecorder({
      store: store as never,
      runId: "run-1",
      conversationId: "conv-1",
      agentType: "general",
    });

    recorder.recordRunStart();
    subscribeRuntimeAgentEvents({
      agent,
      runId: "run-1",
      agentType: "general",
      recorder,
      callbacks,
      onProgress,
    });

    agent.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "hello",
      },
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4.1-mini",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    } as never);

    agent.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "Read",
      args: { file_path: "/tmp/example.txt" },
    } as never);

    agent.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "Read",
      result: {
        content: [{ type: "text", text: "done" }],
        details: { ok: true },
      },
      isError: false,
    } as never);

    expect(onProgress).toHaveBeenCalledWith("hello");
    expect(callbacks.onStream).toHaveBeenCalledWith({
      runId: "run-1",
      agentType: "general",
      seq: 1,
      chunk: "hello",
    });
    expect(callbacks.onToolStart).toHaveBeenCalledWith({
      runId: "run-1",
      agentType: "general",
      seq: 2,
      toolCallId: "tool-1",
      toolName: "Read",
      args: { file_path: "/tmp/example.txt" },
    });
    expect(callbacks.onToolEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        agentType: "general",
        seq: 3,
        toolCallId: "tool-1",
        toolName: "Read",
      }),
    );

    expect(store.recordRunEvent.mock.calls).toEqual([
      [
        expect.objectContaining({
          type: "run_start",
          runId: "run-1",
          conversationId: "conv-1",
          agentType: "general",
        }),
      ],
      [
        expect.objectContaining({
          type: "stream",
          seq: 1,
          chunk: "hello",
        }),
      ],
      [
        expect.objectContaining({
          type: "tool_start",
          seq: 2,
          toolCallId: "tool-1",
          toolName: "Read",
        }),
      ],
      [
        expect.objectContaining({
          type: "tool_end",
          seq: 3,
          toolCallId: "tool-1",
          toolName: "Read",
        }),
      ],
    ]);
  });

  it("emits turn hooks through the shared bridge", async () => {
    const agent = createFakeAgent([
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4.1-mini",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    ]);
    const hookEmitter = {
      emit: vi.fn().mockResolvedValue(undefined),
    };
    const recorder = createRunEventRecorder({
      store: { recordRunEvent: vi.fn() } as never,
      runId: "run-1",
      conversationId: "conv-1",
      agentType: "general",
    });

    subscribeRuntimeAgentEvents({
      agent,
      runId: "run-1",
      agentType: "general",
      recorder,
      hookEmitter: hookEmitter as never,
    });

    agent.emit({ type: "turn_start" } as never);
    agent.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Finished task" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4.1-mini",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 3,
      },
      toolResults: [],
    } as never);

    await Promise.resolve();
    await Promise.resolve();

    expect(hookEmitter.emit).toHaveBeenCalledWith(
      "turn_start",
      {
        agentType: "general",
        messageCount: 2,
      },
      { agentType: "general" },
    );
    expect(hookEmitter.emit).toHaveBeenCalledWith(
      "turn_end",
      {
        agentType: "general",
        assistantText: "Finished task",
      },
      { agentType: "general" },
    );
  });
});
