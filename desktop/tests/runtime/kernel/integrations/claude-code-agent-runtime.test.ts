import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  getClaudeCodeAgentModelId,
  shouldUseClaudeCodeAgentRuntime,
} from "../../../../../runtime/kernel/integrations/claude-code-agent-runtime.js";
import { updateLocalModelPreferences } from "../../../../../runtime/kernel/preferences/local-preferences.js";

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

  it("does not treat Codex as the Claude Code runtime", () => {
    expect(
      shouldUseClaudeCodeAgentRuntime({
        agentEngine: "codex_cli",
        modelId: "openai/gpt-5",
      }),
    ).toBe(false);
  });

  it("lets an explicit Codex engine selection override stale Claude model ids", () => {
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

  it("uses Haiku for agents that default to Stella Light", () => {
    expect(getClaudeCodeAgentModelId(undefined, "stella/light")).toBe(
      "claude-code/haiku",
    );
    expect(getClaudeCodeAgentModelId(undefined, "stella/standard")).toBe(
      "claude-code/default",
    );
  });

  it("keeps an explicit Claude Code model preference for Stella Light agents", () => {
    const stellaHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-claude-light-model-"),
    );
    try {
      updateLocalModelPreferences(stellaHome, {
        claudeCodeModel: "default",
      });
      expect(getClaudeCodeAgentModelId(stellaHome, "stella/light")).toBe(
        "claude-code/haiku",
      );
      updateLocalModelPreferences(stellaHome, {
        claudeCodeModel: "sonnet",
      });
      expect(getClaudeCodeAgentModelId(stellaHome, "stella/light")).toBe(
        "claude-code/sonnet",
      );
    } finally {
      fs.rmSync(stellaHome, { recursive: true, force: true });
    }
  });
});
