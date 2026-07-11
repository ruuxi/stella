import { describe, expect, it, vi } from "vitest";

import {
  executePreparedToolCall,
  type PreparedToolCall,
} from "../../../../../runtime/kernel/agent-core/agent-loop.js";
import type {
  AgentTool,
  AgentToolResult,
} from "../../../../../runtime/kernel/agent-core/types.js";

const makePrepared = (
  execute: AgentTool["execute"],
): PreparedToolCall => ({
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
        onUpdate?.({ content: [{ type: "text", text: `tick ${i}` }], details: {} });
      }
      return okResult;
    });

    const outcome = await executePreparedToolCall(
      prepared,
      undefined,
      (event) => {
        if (event.type === "tool_execution_update") emitted.push(event.toolCallId);
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
