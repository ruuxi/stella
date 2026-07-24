import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  getLocalCliWorkingDirectory,
  isLocalCliAgentId,
} from "../../../../../runtime/contracts/agent-runtime.js";

describe("agent runtime contracts", () => {
  it("keeps the orchestrator on the local CLI runtime, rooted at home", () => {
    expect(getLocalCliWorkingDirectory(AGENT_IDS.ORCHESTRATOR)).toBe("home");
    expect(isLocalCliAgentId(AGENT_IDS.ORCHESTRATOR)).toBe(true);
  });

  it("keeps the general agent on the local CLI runtime, rooted at home", () => {
    expect(getLocalCliWorkingDirectory(AGENT_IDS.GENERAL)).toBe("home");
    expect(isLocalCliAgentId(AGENT_IDS.GENERAL)).toBe(true);
  });

  it("runs the manager as a local conductor rooted at home", () => {
    expect(getLocalCliWorkingDirectory(AGENT_IDS.MANAGER)).toBe("home");
    expect(isLocalCliAgentId(AGENT_IDS.MANAGER)).toBe(true);
  });
});
