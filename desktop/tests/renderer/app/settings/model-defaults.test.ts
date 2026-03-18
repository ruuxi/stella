import { describe, expect, it } from "vitest";
import { AGENT_IDS, MODEL_SETTINGS_AGENTS } from "@/shared/contracts/agent-runtime";
import {
  getConfigurableAgents,
  type ModelDefaultEntry,
} from "@/global/settings/lib/model-defaults";

describe("model-default agent metadata", () => {
  it("derives the configurable agent list from the shared agent registry", () => {
    const defaults: ModelDefaultEntry[] = [
      ...MODEL_SETTINGS_AGENTS.map((agent) => ({
        agentType: agent.key,
        model: "stella/default",
        resolvedModel: "stella/default",
      })),
      {
        agentType: AGENT_IDS.APP,
        model: "stella/default",
        resolvedModel: "stella/default",
      },
    ];

    expect(getConfigurableAgents(defaults)).toEqual(MODEL_SETTINGS_AGENTS);
  });
});
