import { describe, expect, it } from "vitest";

import {
  getFileEditToolFamily,
  rewriteFileEditToolNames,
} from "../../../../../runtime/kernel/tools/file-edit-policy.js";

const model = (provider: string, id: string, api = provider) => ({
  provider,
  id,
  api,
  name: id,
});

describe("file edit tool policy", () => {
  it("keeps apply_patch for OpenAI-authored models", () => {
    expect(
      getFileEditToolFamily({
        agentType: "general",
        model: model("openai", "gpt-5", "openai-responses"),
      }),
    ).toBe("apply_patch");
    expect(
      getFileEditToolFamily({
        agentType: "general",
        model: model("openrouter", "openai/gpt-5", "openai-completions"),
      }),
    ).toBe("apply_patch");
  });

  it("uses Write/Edit for non-OpenAI non-orchestrator agents", () => {
    expect(
      getFileEditToolFamily({
        agentType: "general",
        model: model("anthropic", "claude-sonnet-4.5", "anthropic-messages"),
      }),
    ).toBe("write_edit");

    expect(
      rewriteFileEditToolNames(
        ["exec_command", "apply_patch", "web"],
        "write_edit",
      ),
    ).toEqual(["exec_command", "Write", "Edit", "web"]);
  });

  it("uses Write/Edit for Claude Code runtime even when the configured model is OpenAI-authored", () => {
    expect(
      getFileEditToolFamily({
        agentType: "general",
        model: model("openai", "gpt-5", "openai-responses"),
        agentEngine: "claude_code_local",
      }),
    ).toBe("write_edit");
    expect(
      getFileEditToolFamily({
        agentType: "schedule",
        model: model("openai", "gpt-5", "openai-responses"),
        agentEngine: "claude_code_local",
      }),
    ).toBe("write_edit");
  });

  it("keeps apply_patch for the orchestrator on the default runtime", () => {
    expect(
      getFileEditToolFamily({
        agentType: "orchestrator",
        model: model("anthropic", "claude-sonnet-4.5", "anthropic-messages"),
      }),
    ).toBe("apply_patch");
  });

  it("uses Write/Edit for the orchestrator on the Claude Code runtime", () => {
    expect(
      getFileEditToolFamily({
        agentType: "orchestrator",
        model: model("openai", "gpt-5", "openai-responses"),
        agentEngine: "claude_code_local",
      }),
    ).toBe("write_edit");
  });
});
