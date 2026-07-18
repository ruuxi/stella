import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  getClaudeCodeAgentModelId,
  getClaudeCodeRuntimeEffortLevel,
  shouldUseClaudeCodeAgentRuntime,
} from "../../../../../runtime/kernel/integrations/claude-code-agent-runtime.js";
import { updateLocalModelPreferences } from "../../../../../runtime/kernel/preferences/local-preferences.js";

describe("Claude Code agent runtime selector", () => {
  it("uses a per-spawn effort without changing the saved Claude preference", () => {
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-claude-effort-override-"),
    );
    try {
      updateLocalModelPreferences(stellaDataDir, {
        claudeCodeReasoningEffort: "low",
      });
      expect(getClaudeCodeRuntimeEffortLevel(stellaDataDir, "xhigh")).toBe(
        "xhigh",
      );
      expect(getClaudeCodeRuntimeEffortLevel(stellaDataDir)).toBe("low");
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
    }
  });

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

  it("lets an explicit Stella spawn override a saved Claude Code engine", () => {
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-claude-engine-override-"),
    );
    try {
      updateLocalModelPreferences(stellaDataDir, {
        agentRuntimeEngine: "claude_code_local",
      });
      expect(
        shouldUseClaudeCodeAgentRuntime({
          stellaAppDir: stellaDataDir,
          agentEngine: "default",
          modelId: "stella/gpt-5.6-sol",
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
    }
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

  it("honors a per-spawn pinned model over preferences without persisting it", () => {
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-claude-spawn-model-"),
    );
    try {
      updateLocalModelPreferences(stellaDataDir, {
        claudeCodeModel: "sonnet",
      });
      expect(
        getClaudeCodeAgentModelId(stellaDataDir, undefined, "general", "opus"),
      ).toBe("claude-code/opus");
      // The pin is per-run only — the saved preference still wins afterwards.
      expect(
        getClaudeCodeAgentModelId(stellaDataDir, undefined, "general"),
      ).toBe("claude-code/sonnet");
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
    }
  });

  it("uses Haiku for agents that default to Stella Light", () => {
    expect(getClaudeCodeAgentModelId(undefined, "stella/light")).toBe(
      "claude-code/haiku",
    );
    expect(getClaudeCodeAgentModelId(undefined, "stella/standard")).toBe(
      "claude-code/default",
    );
  });

  it("keeps Stella Light authoritative over a saved Claude Code model", () => {
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-claude-light-model-"),
    );
    try {
      updateLocalModelPreferences(stellaDataDir, {
        claudeCodeModel: "default",
      });
      expect(getClaudeCodeAgentModelId(stellaDataDir, "stella/light")).toBe(
        "claude-code/haiku",
      );
      updateLocalModelPreferences(stellaDataDir, {
        claudeCodeModel: "fable",
      });
      expect(getClaudeCodeAgentModelId(stellaDataDir, "stella/light")).toBe(
        "claude-code/haiku",
      );
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
    }
  });
});
