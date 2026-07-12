import { describe, expect, it } from "vitest";
import { resolveAgentEngineForRun } from "../../../../../runtime/kernel/runner/context.js";

describe("spawn_agent engine precedence", () => {
  it("lets an explicit plain-model spawn override a saved Codex engine", () => {
    expect(
      resolveAgentEngineForRun("codex_cli", { engine: "default" }),
    ).toBe("default");
  });

  it("lets an explicit plain-model spawn override a saved Claude Code engine", () => {
    expect(
      resolveAgentEngineForRun("claude_code_local", { engine: "default" }),
    ).toBe("default");
  });

  it("uses the saved engine only when the spawn has no explicit selection", () => {
    expect(resolveAgentEngineForRun("codex_cli")).toBe("codex_cli");
  });

  it("lets an explicit external engine override the saved engine", () => {
    expect(
      resolveAgentEngineForRun("codex_cli", {
        engine: "claude_code_local",
        model: "opus",
      }),
    ).toBe("claude_code_local");
  });
});
