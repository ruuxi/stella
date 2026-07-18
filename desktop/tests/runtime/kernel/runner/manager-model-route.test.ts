import { describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { resolveAgentModelRoute } from "../../../../../runtime/kernel/runner/context.js";

const routeMocks = vi.hoisted(() => ({
  withMetadata: vi.fn(async (_context, agentType: string, model: string) => ({
    model: {
      id: model.replace(/^stella\//, ""),
      provider: "stella",
      contextWindow: 128_000,
    },
    route: "stella" as const,
    getApiKey: () => "test-key",
    routingAgentType: agentType,
  })),
}));

vi.mock("../../../../../runtime/kernel/runner/model-selection.js", () => ({
  resolveRunnerLlmRoute: vi.fn(),
  resolveRunnerRecallLlmRoute: vi.fn(),
  resolveRunnerLlmRouteWithMetadata: routeMocks.withMetadata,
}));

describe("Manager inherited model routing", () => {
  it("resolves a Manager snapshot through the Orchestrator model identity", async () => {
    const context = {
      stellaDataDir: "/tmp/stella-manager-model-route",
      state: { loadedAgents: [] },
    } as any;

    const resolved = await resolveAgentModelRoute(
      context,
      AGENT_IDS.MANAGER,
      "stella/openai/gpt-5.6-sol",
      AGENT_IDS.ORCHESTRATOR,
    );

    expect(routeMocks.withMetadata).toHaveBeenCalledWith(
      context,
      AGENT_IDS.ORCHESTRATOR,
      "stella/openai/gpt-5.6-sol",
    );
    expect((resolved.resolvedLlm as any).routingAgentType).toBe(
      AGENT_IDS.ORCHESTRATOR,
    );
  });
});
