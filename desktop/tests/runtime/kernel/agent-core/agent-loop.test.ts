import { describe, expect, it, vi } from "vitest";

import {
  executePreparedToolCall,
  type PreparedToolCall,
} from "../../../../../runtime/kernel/agent-core/agent-loop.js";
import { Agent } from "../../../../../runtime/kernel/agent-core/agent.js";
import type {
  AgentTool,
  AgentToolResult,
} from "../../../../../runtime/kernel/agent-core/types.js";
import { createAssistantMessageEventStream } from "../../../../../runtime/ai/utils/event-stream.js";
import type {
  Api,
  AssistantMessage,
  Model,
} from "../../../../../runtime/ai/types.js";

const makePrepared = (execute: AgentTool["execute"]): PreparedToolCall => ({
  kind: "prepared",
  toolCall: {
    type: "toolCall",
    id: "tool-call-1",
    name: "exec_command",
    arguments: {},
  } as never,
  tool: {
    name: "exec_command",
    label: "Exec",
    description: "test tool",
    parameters: { type: "object", properties: {} } as never,
    execute,
  } as AgentTool,
  args: {},
});

const okResult: AgentToolResult<unknown> = {
  content: [{ type: "text", text: "ok" }],
  details: {},
};

const model = {
  id: "agent-loop-empty-test",
  name: "Agent loop empty test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as Model<Api>;

const assistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  api: "openai-completions",
  provider: "test",
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

describe("standalone Agent degenerate response recovery", () => {
  it("retains the default one-shot provider retry", async () => {
    const responses = ["", "recovered"];
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage(
        responses[streamFn.mock.calls.length - 1] ?? "",
      );
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      return stream;
    });
    const agent = new Agent({
      initialState: { model },
      streamFn,
    });

    await agent.prompt("Return a visible result.");

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
  });

  it("forwards the selected provider service tier on every model call", async () => {
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      return stream;
    });
    const agent = new Agent({
      initialState: { model },
      serviceTier: "priority",
      streamFn,
    });

    await agent.prompt("Use Fast.");

    expect(streamFn.mock.calls[0]?.[2]?.serviceTier).toBe("priority");
  });

  it("keeps prompt-cache affinity separate from the agent session", async () => {
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      return stream;
    });
    const agent = new Agent({
      initialState: { model },
      sessionId: "agent-thread-1",
      promptCacheKey: "conversation-1",
      streamFn,
    });

    await agent.prompt("Use the shared conversation cache.");

    expect(streamFn.mock.calls[0]?.[2]).toMatchObject({
      sessionId: "agent-thread-1",
      promptCacheKey: "conversation-1",
    });
  });
});

describe("duplicate tool-call execution", () => {
  it.each(["sequential", "parallel"] as const)(
    "executes semantically identical calls once in %s mode and preserves an output for every call id",
    async (toolExecution) => {
      const execute = vi.fn(async () => okResult);
      const tool = {
        name: "web",
        label: "Web",
        description: "test web tool",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: true,
        } as never,
        execute,
      } as AgentTool;
      const toolMessage: AssistantMessage = {
        ...assistantMessage(""),
        content: [
          {
            type: "toolCall",
            id: "web-call-1",
            name: "web",
            arguments: { query: "Express 5", options: { limit: 5 } },
          },
          {
            type: "toolCall",
            id: "web-call-2",
            name: "web",
            arguments: { options: { limit: 5 }, query: "Express 5" },
          },
        ],
        stopReason: "toolUse",
      };
      const responses = [toolMessage, assistantMessage("done")];
      const streamFn = vi.fn(() => {
        const stream = createAssistantMessageEventStream();
        const message = responses[streamFn.mock.calls.length - 1]!;
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        return stream;
      });
      const agent = new Agent({
        initialState: { model, tools: [tool] },
        streamFn,
        toolExecution,
      });

      await agent.prompt("Check the release notes.");

      expect(execute).toHaveBeenCalledTimes(1);
      const results = agent.state.messages.filter(
        (message) => message.role === "toolResult",
      );
      expect(results.map((message) => message.toolCallId)).toEqual([
        "web-call-1",
        "web-call-2",
      ]);
      expect(results[0]?.content).toEqual(okResult.content);
      expect(results[1]?.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Exact duplicate skipped"),
      });
    },
  );
});

describe("executePreparedToolCall inactivity bound", () => {
  it("cancels a fully silent tool and reports an error result instead of hanging", async () => {
    let toolSignal: AbortSignal | undefined;
    const prepared = makePrepared((_id, _args, signal) => {
      toolSignal = signal;
      return new Promise(() => {});
    });

    const outcome = await executePreparedToolCall(
      prepared,
      undefined,
      vi.fn(),
      25,
    );

    expect(outcome.isError).toBe(true);
    const text = outcome.result.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join(" ");
    expect(text).toContain("produced no output");
    expect(toolSignal?.aborted).toBe(true);
  });

  it("keeps a long-running tool alive as long as it reports progress", async () => {
    const emitted: string[] = [];
    const prepared = makePrepared(async (_id, _args, signal, onUpdate) => {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        expect(signal?.aborted).toBe(false);
        onUpdate?.({
          content: [{ type: "text", text: `tick ${i}` }],
          details: {},
        });
      }
      return okResult;
    });

    const outcome = await executePreparedToolCall(
      prepared,
      undefined,
      (event) => {
        if (event.type === "tool_execution_update")
          emitted.push(event.toolCallId);
      },
      40,
    );

    expect(outcome.isError).toBe(false);
    expect(outcome.result).toEqual(okResult);
    expect(emitted).toHaveLength(5);
  });

  it("disables the bound when the timeout is <= 0", async () => {
    const prepared = makePrepared(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return okResult;
    });

    const outcome = await executePreparedToolCall(
      prepared,
      undefined,
      vi.fn(),
      0,
    );

    expect(outcome.isError).toBe(false);
    expect(outcome.result).toEqual(okResult);
  });

  it("propagates an outer abort to the tool's composed signal", async () => {
    const outer = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const prepared = makePrepared((_id, _args, signal) => {
      toolSignal = signal;
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const execution = executePreparedToolCall(
      prepared,
      outer.signal,
      vi.fn(),
      10_000,
    );
    outer.abort();
    const outcome = await execution;

    expect(toolSignal?.aborted).toBe(true);
    expect(outcome.isError).toBe(true);
  });
});
