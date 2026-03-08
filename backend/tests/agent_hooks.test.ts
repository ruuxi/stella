import { describe, test, expect } from "bun:test";
import type {
  BeforeChatParams,
  BeforeChatResult,
  AfterChatParams,
  AfterToolParams,
} from "../convex/agent/hooks";

describe("hook type contracts", () => {
  test("BeforeChatParams has required fields", () => {
    const params: BeforeChatParams = {
      ownerId: "user-1",
      conversationId: "conv-1" as any,
      agentType: "general",
      modelString: "claude-opus-4.6",
    };
    expect(params.ownerId).toBe("user-1");
    expect(params.agentType).toBe("general");
  });

  test("BeforeChatResult can be allowed", () => {
    const result: BeforeChatResult = { allowed: true };
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("BeforeChatResult can be denied with reason", () => {
    const result: BeforeChatResult = {
      allowed: false,
      reason: "Rate limited",
      retryAfterMs: 5000,
    };
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(5000);
  });

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
