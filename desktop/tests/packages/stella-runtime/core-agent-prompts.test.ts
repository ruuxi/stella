import { describe, expect, it } from "vitest";
import { buildBundledCoreAgents } from "../../../electron/core/runtime/agents/core-agent-prompts.js";

describe("bundled core agent prompts", () => {
  it("includes TaskUpdate in the orchestrator tool allowlist", () => {
    const orchestrator = buildBundledCoreAgents().find((agent) => agent.id === "orchestrator");
    expect(orchestrator?.toolsAllowlist).toContain("TaskUpdate");
    expect(orchestrator?.toolsAllowlist).not.toContain("Task");
  });
});
