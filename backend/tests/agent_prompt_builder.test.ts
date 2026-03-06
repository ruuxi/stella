import { describe, test, expect } from "bun:test";

// Import the module to test non-exported functions via the module's behavior
// We can test getPlatformGuidance and buildSkillsSection indirectly
// but since they're not exported, let's test the exported constants and types

// For now, test the pure functions that are importable
// getPlatformGuidance and buildSkillsSection are private, so we verify them through the module

// Actually, let's test what we can import
import { SKILLS_DISABLED_AGENT_TYPES, SUBAGENT_TYPES, BROWSER_AGENT_SAFARI_DENIED_REASON } from "../convex/lib/agent_constants";

describe("agent_constants", () => {
  test("SKILLS_DISABLED_AGENT_TYPES is a Set", () => {
    expect(SKILLS_DISABLED_AGENT_TYPES).toBeInstanceOf(Set);
  });

  test("explore agent has skills disabled", () => {
    expect(SKILLS_DISABLED_AGENT_TYPES.has("explore")).toBe(true);
  });

  test("general agent has skills enabled", () => {
    expect(SKILLS_DISABLED_AGENT_TYPES.has("general")).toBe(false);
  });

  test("SUBAGENT_TYPES includes expected types", () => {
    expect(SUBAGENT_TYPES).toContain("general");
    expect(SUBAGENT_TYPES).toContain("explore");
    expect(SUBAGENT_TYPES).toContain("browser");
    expect(SUBAGENT_TYPES).toHaveLength(3);
  });

  test("BROWSER_AGENT_SAFARI_DENIED_REASON is a non-empty string", () => {
    expect(typeof BROWSER_AGENT_SAFARI_DENIED_REASON).toBe("string");
    expect(BROWSER_AGENT_SAFARI_DENIED_REASON.length).toBeGreaterThan(0);
  });
});
