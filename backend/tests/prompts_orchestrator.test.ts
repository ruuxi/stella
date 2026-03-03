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

  test("defines routing paths", () => {
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("Routing");
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("General");
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("Explore");
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("Browser");
  });

  test("mentions memory capabilities", () => {
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("RecallMemories");
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("SaveMemory");
  });

  test("includes direct tool guardrails", () => {
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("Direct Tool Guardrails");
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("TaskCreate");
  });

  test("includes communication guidelines", () => {
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("Acknowledge first");
    expect(ORCHESTRATOR_AGENT_SYSTEM_PROMPT).toContain("NoResponse");
  });
});
