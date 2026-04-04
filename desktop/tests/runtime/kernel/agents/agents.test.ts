import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../../../src/shared/contracts/agent-runtime.js";
import {
  getBundledCoreAgentFallback,
  loadBundledAgents,
} from "../../../../runtime/kernel/agents/agents.js";

describe("agents", () => {
  it("loads bundled core agents directly from checked-in definitions", () => {
    const agents = loadBundledAgents();

    expect(agents.map((agent) => agent.id)).toEqual([
      AGENT_IDS.ORCHESTRATOR,
      AGENT_IDS.SCHEDULE,
      AGENT_IDS.GENERAL,
    ]);
  });

  it("does not use the internal fallback for roster agents", () => {
    expect(getBundledCoreAgentFallback(AGENT_IDS.ORCHESTRATOR)).toBeUndefined();
  });
});
