import { describe, test, expect } from "bun:test";
import { GENERAL_AGENT_SYSTEM_PROMPT } from "../convex/prompts/general";

describe("GENERAL_AGENT_SYSTEM_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof GENERAL_AGENT_SYSTEM_PROMPT).toBe("string");
    expect(GENERAL_AGENT_SYSTEM_PROMPT.length).toBeGreaterThan(500);
  });

  test("identifies as General Agent", () => {
    expect(GENERAL_AGENT_SYSTEM_PROMPT).toContain("General Agent");
  });

  test("describes capabilities", () => {
    expect(GENERAL_AGENT_SYSTEM_PROMPT).toContain("Edit");
    expect(GENERAL_AGENT_SYSTEM_PROMPT).toContain("Bash");
  });

  test("mentions credential workflow", () => {
    expect(GENERAL_AGENT_SYSTEM_PROMPT).toContain("RequestCredential");
    expect(GENERAL_AGENT_SYSTEM_PROMPT).toContain("IntegrationRequest");
    expect(GENERAL_AGENT_SYSTEM_PROMPT).toContain("secretId");
  });

  test("mentions canvas capabilities", () => {
    expect(GENERAL_AGENT_SYSTEM_PROMPT).toContain("Canvas");
    expect(GENERAL_AGENT_SYSTEM_PROMPT).toContain("panel");
  });
});
