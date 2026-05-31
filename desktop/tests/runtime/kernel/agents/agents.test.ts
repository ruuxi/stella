import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import {
  getBundledCoreAgentFallback,
  loadBundledAgents,
  mergeBundledAndExtensionAgents,
} from "../../../../../runtime/kernel/agents/agents.js";
import type { ParsedAgent } from "../../../../../runtime/kernel/agents/types.js";

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

  it("keeps bundled core agents when extensions register only custom agents", () => {
    const agents = mergeBundledAndExtensionAgents([
      makeAgent({ id: "scout", agentTypes: ["scout"] }),
    ]);

    expect(agents.map((agent) => agent.id)).toEqual([
      AGENT_IDS.ORCHESTRATOR,
      AGENT_IDS.SCHEDULE,
      AGENT_IDS.GENERAL,
      "scout",
    ]);
    expect(
      agents.find((agent) => agent.id === AGENT_IDS.ORCHESTRATOR)
        ?.toolsAllowlist,
    ).toContain("spawn_agent");
  });

  it("lets extension agents override bundled agents by id", () => {
    const replacement = makeAgent({
      id: AGENT_IDS.GENERAL,
      toolsAllowlist: ["Read"],
    });

    const agents = mergeBundledAndExtensionAgents([replacement]);

    expect(agents.find((agent) => agent.id === AGENT_IDS.GENERAL)).toBe(
      replacement,
    );
    expect(
      agents.filter((agent) => agent.id === AGENT_IDS.GENERAL),
    ).toHaveLength(1);
  });

  it("lets extension agents override bundled agents by agent type", () => {
    const replacement = makeAgent({
      id: "custom-general",
      agentTypes: [AGENT_IDS.GENERAL],
      toolsAllowlist: ["Read"],
    });

    const agents = mergeBundledAndExtensionAgents([replacement]);

    expect(
      agents.find((agent) => agent.agentTypes.includes(AGENT_IDS.GENERAL)),
    ).toBe(replacement);
    expect(
      agents.filter(
        (agent) =>
          agent.id === AGENT_IDS.GENERAL ||
          agent.agentTypes.includes(AGENT_IDS.GENERAL),
      ),
    ).toHaveLength(1);
  });
});

const makeAgent = (
  overrides: Partial<ParsedAgent> & { id: string },
): ParsedAgent => ({
  id: overrides.id,
  name: overrides.name ?? overrides.id,
  description: overrides.description ?? `${overrides.id} agent`,
  systemPrompt: overrides.systemPrompt ?? `You are ${overrides.id}.`,
  agentTypes: overrides.agentTypes ?? [overrides.id],
  ...(overrides.toolsAllowlist
    ? { toolsAllowlist: overrides.toolsAllowlist }
    : {}),
  ...(overrides.model ? { model: overrides.model } : {}),
  ...(typeof overrides.maxAgentDepth === "number"
    ? { maxAgentDepth: overrides.maxAgentDepth }
    : {}),
});
