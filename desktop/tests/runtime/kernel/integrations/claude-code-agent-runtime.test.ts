import { describe, expect, it } from "vitest";

import {
  getClaudeCodeAgentModelId,
  shouldUseClaudeCodeAgentRuntime,
} from "../../../../../runtime/kernel/integrations/claude-code-agent-runtime.js";

describe("Claude Code agent runtime selector", () => {
  it("uses Claude Code for any agent when the shared runtime engine is selected", () => {
    expect(
      shouldUseClaudeCodeAgentRuntime({
        agentEngine: "claude_code_local",
        modelId: "openai/gpt-5",
      }),
    ).toBe(true);
  });

  it("does not require local CLI agent metadata to recognize a Claude Code model", () => {
    expect(
      shouldUseClaudeCodeAgentRuntime({
        agentEngine: "default",
        modelId: "claude-code/schedule",
      }),
    ).toBe(true);
  });

  it("keeps the Stella runtime when no Claude Code signal is present", () => {
    expect(
      shouldUseClaudeCodeAgentRuntime({
        agentEngine: "default",
        modelId: "openai/gpt-5",
      }),
    ).toBe(false);
  });

  it("does not treat Cursor as the Claude Code runtime", () => {
    expect(
      shouldUseClaudeCodeAgentRuntime({
        agentEngine: "cursor_sdk",
        modelId: "openai/gpt-5",
      }),
    ).toBe(false);
  });

  it("does not treat Codex as the Claude Code runtime", () => {
    expect(
      shouldUseClaudeCodeAgentRuntime({
        agentEngine: "codex_cli",
        modelId: "openai/gpt-5",
      }),
    ).toBe(false);
  });

  it("lets explicit Cursor and Codex engine selections override stale Claude model ids", () => {
    expect(
      shouldUseClaudeCodeAgentRuntime({
        agentEngine: "cursor_sdk",
        modelId: "claude-code/default",
      }),
    ).toBe(false);
    expect(
      shouldUseClaudeCodeAgentRuntime({
        agentEngine: "codex_cli",
        modelId: "claude-code/default",
      }),
    ).toBe(false);
  });

  it("uses Claude Code's default model instead of a Stella agent type", () => {
    expect(getClaudeCodeAgentModelId()).toBe("claude-code/default");
  });
});
