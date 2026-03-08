import { describe, test, expect } from "bun:test";
import { ORCHESTRATOR_AGENT_SYSTEM_PROMPT } from "../convex/prompts/orchestrator";

describe("ORCHESTRATOR_AGENT_SYSTEM_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toBe("string");
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT.length).toBeGreaterThan(500);
  });

  test("identifies as Stella", () => {
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("Stella");
  });

  test("describes offline fallback role", () => {
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("offline");
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("backend fallback responder");
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("NoResponse");
  });
});
