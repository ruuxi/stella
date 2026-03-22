import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../../../packages/ai/models.js";
import type {
  AgentLoopConfig,
  AgentMessage,
} from "../../../packages/runtime-kernel/agent-core/types.js";

const { captured } = vi.hoisted(() => ({
  captured: {
    runConfig: null as unknown,
    continueConfig: null as unknown,
  },
}));

vi.mock("../../../packages/runtime-kernel/agent-core/agent-loop.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../packages/runtime-kernel/agent-core/agent-loop.js")
  >("../../../packages/runtime-kernel/agent-core/agent-loop.js");

  return {
    ...actual,
    runAgentLoop: vi.fn(async (_messages, _context, config) => {
      captured.runConfig = config;
      return [];
    }),
    runAgentLoopContinue: vi.fn(async (_context, config) => {
      captured.continueConfig = config;
      return [];
    }),
  };
});

import { Agent } from "../../../packages/runtime-kernel/agent-core/agent.js";

const userMessage: AgentMessage = {
  role: "user",
  content: [{ type: "text", text: "hello" }],
  timestamp: 1,
};

describe("agent upstream contract guards", () => {
  beforeEach(() => {
    captured.runConfig = null;
    captured.continueConfig = null;
  });

  it("wraps throwing helpers and hooks with safe fallbacks before entering the loop", async () => {
    const agent = new Agent({
      initialState: {
        model: getModel("openai", "gpt-4.1-mini"),
      },
      convertToLlm: async () => {
        throw new Error("convert failed");
      },
      transformContext: async () => {
        throw new Error("transform failed");
      },
      getApiKey: async () => {
        throw new Error("api key failed");
      },
      beforeToolCall: async () => {
        throw new Error("before failed");
      },
      afterToolCall: async () => {
        throw new Error("after failed");
      },
    });

    (agent as unknown as { dequeueSteeringMessages: () => AgentMessage[] }).dequeueSteeringMessages =
      () => {
        throw new Error("steering failed");
      };
    (agent as unknown as { dequeueFollowUpMessages: () => AgentMessage[] }).dequeueFollowUpMessages =
      () => {
        throw new Error("follow-up failed");
      };

    await agent.prompt(userMessage);

    const config = captured.runConfig as AgentLoopConfig | null;
    expect(config).not.toBeNull();

    await expect(config?.convertToLlm([userMessage])).resolves.toEqual([userMessage]);
    await expect(config?.transformContext?.([userMessage])).resolves.toEqual([userMessage]);
    await expect(config?.getApiKey?.("openai")).resolves.toBeUndefined();
    await expect(config?.getSteeringMessages?.()).resolves.toEqual([]);
    await expect(config?.getFollowUpMessages?.()).resolves.toEqual([]);
    await expect(
      config?.beforeToolCall?.({
        assistantMessage: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "Read",
              arguments: { file_path: "/tmp/test.txt" },
            },
          ],
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
          stopReason: "tool_use",
          timestamp: 1,
        } as never,
        toolCall: {
          type: "toolCall",
          id: "call-1",
          name: "Read",
          arguments: { file_path: "/tmp/test.txt" },
        } as never,
        args: { file_path: "/tmp/test.txt" },
        context: {
          systemPrompt: "system",
          messages: [userMessage],
          tools: [],
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      config?.afterToolCall?.({
        assistantMessage: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "Read",
              arguments: { file_path: "/tmp/test.txt" },
            },
          ],
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
          stopReason: "tool_use",
          timestamp: 1,
        } as never,
        toolCall: {
          type: "toolCall",
          id: "call-1",
          name: "Read",
          arguments: { file_path: "/tmp/test.txt" },
        } as never,
        args: { file_path: "/tmp/test.txt" },
        result: {
          content: [{ type: "text", text: "ok" }],
          details: { ok: true },
        },
        isError: false,
        context: {
          systemPrompt: "system",
          messages: [userMessage],
          tools: [],
        },
      }),
    ).resolves.toBeUndefined();
  });
});

