import { describe, expect, it } from "vitest";
import { buildBundledCoreAgents } from "../../../packages/runtime-kernel/agents/core-agent-prompts.js";
import { BUNDLED_CORE_AGENT_IDS } from "../../../src/shared/contracts/agent-runtime.js";

describe("bundled core agent prompts", () => {
  it("includes TaskUpdate in the orchestrator tool allowlist", () => {
    const orchestrator = buildBundledCoreAgents().find((agent) => agent.id === "orchestrator");
    expect(orchestrator?.toolsAllowlist).toContain("TaskUpdate");
    expect(orchestrator?.toolsAllowlist).not.toContain("Task");
  });

  it("stays aligned with the shared bundled agent registry", () => {
    expect(buildBundledCoreAgents().map((agent) => agent.id)).toEqual(
      BUNDLED_CORE_AGENT_IDS,
    );
  });
});
