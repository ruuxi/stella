import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeToolRuntimePrompt,
  getClaudeCodeStatusChangeFromStreamEvent,
  isClaudeCodeModel,
  parseClaudeCodeDecision,
} from "../../../../../runtime/kernel/integrations/claude-code-session-runtime.js";

describe("claude-code-session-runtime", () => {
  it("builds a Stella-hosted tool contract prompt", () => {
    const prompt = buildClaudeCodeToolRuntimePrompt("Base system prompt", [
      {
        name: "Read",
        description: "Read a file from disk",
        parameters: { type: "object" },
      },
      {
        name: "Bash",
        description: "Run a shell command",
        parameters: { type: "object" },
      },
    ]);

    expect(prompt).toContain("Base system prompt");
    expect(prompt).toContain("Claude Code built-in tools are disabled");
    expect(prompt).toContain('"name": "Read"');
    expect(prompt).toContain('"name": "Bash"');
    expect(prompt).toContain('"type":"tool_request"');
    expect(prompt).toContain('"type":"final"');
  });

  it("parses valid structured Claude decisions", () => {
    expect(
      parseClaudeCodeDecision({
        type: "final",
        message: "Done.",
      }),
    ).toEqual({
      type: "final",
      message: "Done.",
    });

    expect(
      parseClaudeCodeDecision({
        type: "tool_request",
        toolName: "Read",
        args: { file_path: "src/index.ts" },
      }),
    ).toEqual({
      type: "tool_request",
      toolName: "Read",
      args: { file_path: "src/index.ts" },
    });
  });

  it("rejects malformed Claude decisions", () => {
    expect(parseClaudeCodeDecision(null)).toBeNull();
    expect(parseClaudeCodeDecision({ type: "final" })).toBeNull();
    expect(
      parseClaudeCodeDecision({
        type: "tool_request",
        toolName: "Read",
        args: "bad",
      }),
    ).toBeNull();
  });

  it("detects Claude Code model identifiers", () => {
    expect(isClaudeCodeModel("claude-code/default")).toBe(true);
    expect(isClaudeCodeModel("claude-code/claude-sonnet-4-6")).toBe(true);
    expect(isClaudeCodeModel("anthropic/claude-sonnet-4-6")).toBe(false);
  });

  it("maps Claude compact hooks into transient status changes", () => {
    expect(
      getClaudeCodeStatusChangeFromStreamEvent({
        type: "system",
        subtype: "hook_started",
        hook_event: "PreCompact",
      }),
    ).toEqual({
      state: "compacting",
      text: "Compacting context",
    });

    expect(
      getClaudeCodeStatusChangeFromStreamEvent({
        type: "system",
        subtype: "hook_response",
        hook_event: "PostCompact",
      }),
    ).toEqual({
      state: "running",
      text: "Working",
    });

    expect(
      getClaudeCodeStatusChangeFromStreamEvent({
        type: "assistant",
        subtype: "message",
      }),
    ).toBeNull();
  });
});
