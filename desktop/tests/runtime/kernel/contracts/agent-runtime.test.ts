import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  getAgentEnginePreference,
  getLocalCliWorkingDirectory,
  isLocalCliAgentId,
} from "../../../../src/shared/contracts/agent-runtime.js";

describe("agent runtime contracts", () => {
  it("routes the orchestrator through the shared local CLI engine preference", () => {
    expect(getAgentEnginePreference(AGENT_IDS.ORCHESTRATOR)).toBe("general");
    expect(getLocalCliWorkingDirectory(AGENT_IDS.ORCHESTRATOR)).toBe(
      "frontend",
    );
    expect(isLocalCliAgentId(AGENT_IDS.ORCHESTRATOR)).toBe(true);
  });

  it("keeps the general agent on the local CLI runtime", () => {
    expect(getAgentEnginePreference(AGENT_IDS.GENERAL)).toBe("general");
    expect(getLocalCliWorkingDirectory(AGENT_IDS.GENERAL)).toBe("frontend");
    expect(isLocalCliAgentId(AGENT_IDS.GENERAL)).toBe(true);
  });
});
