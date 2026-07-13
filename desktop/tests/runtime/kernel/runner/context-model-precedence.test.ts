import { describe, expect, it } from "vitest";
import type { Model } from "../../../../../runtime/ai/types.js";
import {
  resolveAgentEngineForRun,
  resolveSpawnReasoningEffortForModel,
} from "../../../../../runtime/kernel/runner/context.js";

describe("spawn_agent engine precedence", () => {
  it("lets an explicit plain-model spawn override a saved Codex engine", () => {
    expect(resolveAgentEngineForRun("codex_cli", { engine: "default" })).toBe(
      "default",
    );
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

describe("spawn_agent Stella reasoning clamping", () => {
  const model = (
    reasoning: boolean,
    thinkingLevelMap?: Model<any>["thinkingLevelMap"],
  ) => ({ reasoning, thinkingLevelMap }) as Model<any>;

  it("clamps to the nearest supported model effort", () => {
    const mediumHighOnly = model(true, {
      off: null,
      minimal: null,
      low: null,
      xhigh: null,
    });
    expect(resolveSpawnReasoningEffortForModel(mediumHighOnly, "low")).toBe(
      "medium",
    );
    expect(resolveSpawnReasoningEffortForModel(mediumHighOnly, "xhigh")).toBe(
      "high",
    );
  });

  it("drops a spawn effort when the resolved model has no dial", () => {
    expect(
      resolveSpawnReasoningEffortForModel(model(false), "high"),
    ).toBeUndefined();
  });
});
