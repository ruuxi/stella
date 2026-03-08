import { describe, test, expect } from "bun:test";
import type {
  AfterChatParams,
  AfterToolParams,
} from "../convex/agent/hooks";

describe("hook type contracts", () => {
  test("AfterChatParams includes usage info", () => {
    const params: AfterChatParams = {
      ownerId: "user-1",
      conversationId: "conv-1" as any,
      agentType: "general",
      modelString: "claude-opus-4.6",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      durationMs: 2000,
      success: true,
    };
    expect(params.usage?.totalTokens).toBe(150);
    expect(params.durationMs).toBe(2000);
  });

  test("AfterToolParams has tool name", () => {
    const params: AfterToolParams = {
      ownerId: "user-1",
      conversationId: "conv-1" as any,
      agentType: "general",
      toolName: "Read",
      success: true,
      durationMs: 500,
    };
    expect(params.toolName).toBe("Read");
  });
});
